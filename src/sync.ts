/**
 * Updates the dividend data from the TWSE and TPEx open data. Run once a day after the market closes
 * (deploy/stock-dividend-sync.timer). The first run reads every trading day since 2004 and takes about
 * half a day; it saves its progress after every day, so a stopped run carries on where it left off.
 *
 * 1. Read the ex-dividend tables (除權除息計算結果表) into the dividend_event collection.
 * 2. For ex-dates on which shares were given out, read the cash and share amounts from the TWSE detail page.
 * 3. Go through the daily closing prices and mark an ex-date as filled on the first trading day
 *    on which the stock closed at the pre-ex close or above.
 * 4. Write each stock's summary into the stock collection, which the API answers from,
 *    and the list of listed securities into Redis.
 */
import { AnyBulkWriteOperation, Collection, Db, Document, WithId } from 'mongodb';
import { connect as mongodbConnect, disconnect as mongodbDisconnect } from './db/mongodb';
import { connect as redisConnect, RedisClient } from './db/redis';
import { DividendEvent, findFilledEvents, Market, summarizeDividends, TrackedDividendEvent } from './dividend/summary';
import { datesToCheck, eventsReadStart, judgeDay, rewindCheckpoint, targetDate, toEventUpsert } from './dividend/sync-rules';
import { laterOf, taipeiNow, yearRanges } from './sources/format';
import { describeError, RateLimitedClient } from './sources/rate-limited-client';
import { fetchTpexCloses, fetchTpexEvents } from './sources/tpex';
import { fetchTwseCloses, fetchTwseDetail, fetchTwseEvents, StockClose } from './sources/twse';

const EVENT_COLLECTION = 'dividend_event';
const STOCK_COLLECTION = 'stock';
const STATE_COLLECTION = 'sync_state';
const STATE_ID = 'dividend';
const STOCKS = 'STOCKS';
const STOCK_LIST_UPDATED = 'STOCK_LIST_UPDATED';
const SOURCE = 'twse-tpex';

/** MI_INDEX has daily closing prices from this day on, so older ex-dates cannot be checked. */
const TWSE_FIRST_DATE = '2004-02-11';
/** The TPEx pages have closing prices from 2007-07 and ex-dividend data from 2007-12 on. */
const TPEX_FIRST_DATE = '2007-07-02';
const TWSE_REQUEST_INTERVAL_MS = 3500;
const TPEX_REQUEST_INTERVAL_MS = 3000;
const BULK_WRITE_SIZE = 500;
const PROGRESS_LOG_EVERY = 100;
/** Give up on Redis after this many connection attempts, so a run cannot hang. */
const REDIS_MAX_RETRIES = 20;

interface SyncState {
    _id: string;
    /** The last day whose closing prices were checked */
    lastCloseDate?: string;
    /** The last day whose ex-dividend data was read, per market */
    eventsReadThrough?: Partial<Record<Market, string>>;
}

interface MarketSource {
    market: Market;
    firstDate: string;
    fetchEvents: (start: string, end: string) => Promise<DividendEvent[]>;
    fetchCloses: (date: string) => Promise<Map<string, StockClose> | null>;
}

interface TradingDay {
    date: string;
    twse: Map<string, StockClose>;
    tpex: Map<string, StockClose>;
}

interface SyncContext {
    events: Collection<TrackedDividendEvent>;
    states: Collection<SyncState>;
    twse: RateLimitedClient;
    sources: MarketSource[];
    /** SYNC_START_DATE lets a trial run start later than 2004. */
    firstDate: string;
    lastDate: string;
    today: string;
}

type DayCloses = Partial<Record<Market, Map<string, StockClose>>>;

function log(message: string) {
    console.log(`[sync] ${message}`);
}

async function bulkWriteInChunks<T extends Document>(collection: Collection<T>, operations: AnyBulkWriteOperation<T>[]) {
    for(let index = 0; index < operations.length; index += BULK_WRITE_SIZE) {
        await collection.bulkWrite(operations.slice(index, index + BULK_WRITE_SIZE), { ordered: false });
    }
}

/** Saves the events and returns the ex-dates of the ones that were not saved before. */
async function upsertEvents(collection: Collection<TrackedDividendEvent>, events: DividendEvent[]): Promise<string[]> {
    const newDates: string[] = [];
    for(let index = 0; index < events.length; index += BULK_WRITE_SIZE) {
        const chunk = events.slice(index, index + BULK_WRITE_SIZE);
        const result = await collection.bulkWrite(chunk.map(toEventUpsert), { ordered: false });
        for(const position of Object.keys(result.upsertedIds)) newDates.push(chunk[Number(position)].date);
    }
    return newDates;
}

async function readEvents(context: SyncContext, state: SyncState, source: MarketSource): Promise<string[]> {
    const firstDate = laterOf(source.firstDate, context.firstDate);
    const newDates: string[] = [];
    for(const range of yearRanges(eventsReadStart(state.eventsReadThrough?.[source.market], firstDate), context.lastDate)) {
        const found = await source.fetchEvents(range.start, range.end);
        newDates.push(...(await upsertEvents(context.events, found)));
        await context.states.updateOne({ _id: STATE_ID }, { $set: { [`eventsReadThrough.${source.market}`]: range.end } }, { upsert: true });
        log(`${source.market} ex-dividend data ${range.start}..${range.end}: ${found.length} rows`);
    }
    return newDates;
}

/** A newly published ex-date on a day that was already checked: check again from that day on. */
async function rewindForNewEvents(context: SyncContext, state: SyncState, newDates: string[]) {
    const rewound = rewindCheckpoint(state.lastCloseDate, newDates);
    if(rewound === state.lastCloseDate) return;
    log(`new ex-dates on days already checked; checking again from ${rewound} on`);
    state.lastCloseDate = rewound;
    await context.states.updateOne({ _id: STATE_ID }, { $set: { lastCloseDate: rewound } });
}

async function readTwseAmounts(context: SyncContext) {
    const pending = await context.events.find({ market: 'twse', cashDividend: null }).sort({ date: 1 }).toArray();
    let estimated = 0;
    let missing = 0;
    for(const [index, event] of pending.entries()) {
        // Throws on an unexpected answer, so the run stops and the event is asked again on the next run.
        const detail = await fetchTwseDetail(context.twse, event.id, event.date);
        const amount = detail ?? event.estimatedAmount;
        if(amount) {
            if(!detail) estimated++;
            await context.events.updateOne({ _id: event._id }, { $set: { ...amount, amountEstimated: !detail } });
        } else {
            // The page has no data for it and the table gives no estimate: left out of the summary, not asked again.
            missing++;
            await context.events.updateOne({ _id: event._id }, { $set: { cashDividend: 0, stockDividendPerShare: 0, amountUnavailable: true } });
            console.warn(`[sync] no amounts for ${event.id} on ${event.date}, neither on the detail page nor in the table; leaving it out`);
        }
        if((index + 1) % PROGRESS_LOG_EVERY === 0) log(`dividend amounts ${index + 1}/${pending.length}`);
    }
    log(`dividend amounts read for ${pending.length - missing} ex-dates (${estimated} estimated from the table), ${missing} without amounts`);
}

function expectedSources(context: SyncContext, date: string): MarketSource[] {
    return context.sources.filter((source) => date >= source.firstDate);
}

async function readCloses(sources: MarketSource[], date: string, closes: DayCloses = {}): Promise<DayCloses> {
    const answers = await Promise.all(sources.map((source) => source.fetchCloses(date)));
    const result: DayCloses = { ...closes };
    sources.forEach((source, index) => {
        const answer = answers[index];
        if(answer) result[source.market] = answer;
    });
    return result;
}

/**
 * Reads one day's closing prices from every market that has data for it. When only one market answers
 * with prices, the other is asked once more; a recent day still missing a market stops the run so a later
 * run can try again, an older one is accepted with a warning.
 */
async function readClosesOfDay(context: SyncContext, date: string): Promise<DayCloses> {
    const sources = expectedSources(context, date);
    const expected = sources.map((source) => source.market);
    const traded = (closes: DayCloses) => expected.filter((market) => closes[market] !== undefined);
    let closes = await readCloses(sources, date);
    if(judgeDay(expected, traded(closes), date, context.today) === 'holiday' || traded(closes).length === expected.length) return closes;
    closes = await readCloses(sources.filter((source) => !closes[source.market]), date, closes);
    const verdict = judgeDay(expected, traded(closes), date, context.today);
    if(verdict === 'retry-later') throw new Error(`${date}: only ${traded(closes).join(', ')} has closing prices yet`);
    if(verdict === 'one-market') console.warn(`[sync] ${date}: only ${traded(closes).join(', ')} has closing prices; going on without the other market`);
    return closes;
}

function toPriceMap(closes: DayCloses): Map<string, number> {
    const prices = new Map<string, number>();
    for(const marketCloses of Object.values(closes)) {
        for(const [id, { close }] of marketCloses ?? []) prices.set(id, close);
    }
    return prices;
}

/** Checks the closing prices of every day since the last run. Returns the latest day on which both markets traded. */
async function checkFills(context: SyncContext, state: SyncState): Promise<TradingDay | undefined> {
    let open: WithId<TrackedDividendEvent>[] = await context.events.find({ filledDate: null }).toArray();
    let latest: TradingDay | undefined;
    for(const [index, date] of datesToCheck(state.lastCloseDate, context.firstDate, context.lastDate).entries()) {
        const closes = await readClosesOfDay(context, date);
        const filled = findFilledEvents(open, date, toPriceMap(closes));
        if(filled.length > 0) {
            await bulkWriteInChunks(context.events, filled.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $set: { filledDate: date } } } })));
            const filledIds = new Set(filled.map((event) => event._id.toHexString()));
            open = open.filter((event) => !filledIds.has(event._id.toHexString()));
        }
        if(closes.twse && closes.tpex) latest = { date, twse: closes.twse, tpex: closes.tpex };
        // Saved after the fills, so a run that stops in between checks the day again; that is safe.
        await context.states.updateOne({ _id: STATE_ID }, { $set: { lastCloseDate: date } }, { upsert: true });
        if((index + 1) % PROGRESS_LOG_EVERY === 0) log(`closing prices checked through ${date}, ${open.length} ex-dates not filled yet`);
    }
    log(`closing prices checked through ${context.lastDate}, ${open.length} ex-dates not filled yet`);
    return latest;
}

function groupById(events: TrackedDividendEvent[]): Map<string, TrackedDividendEvent[]> {
    const groups = new Map<string, TrackedDividendEvent[]>();
    for(const event of events) {
        const list = groups.get(event.id) ?? [];
        list.push(event);
        groups.set(event.id, list);
    }
    return groups;
}

async function publishSummaries(db: Db, context: SyncContext, latest: TradingDay | undefined) {
    const events = await context.events.find({}, { projection: { _id: 0 } }).sort({ date: 1 }).toArray();
    const operations: AnyBulkWriteOperation[] = [];
    for(const [id, stockEvents] of groupById(events)) {
        const summary = summarizeDividends(stockEvents);
        if(!summary) continue;
        const name = latest?.twse.get(id)?.name ?? latest?.tpex.get(id)?.name ?? stockEvents[stockEvents.length - 1].name;
        operations.push({
            updateOne: {
                filter: { id },
                update: { $set: { name, ...summary, source: SOURCE, dataThrough: context.lastDate, updated: new Date() } },
                upsert: true,
            },
        });
    }
    await bulkWriteInChunks(db.collection(STOCK_COLLECTION), operations);
    log(`summaries written for ${operations.length} stocks`);
}

/** The search box offers the securities listed on the latest day on which both markets traded. */
async function publishStockList(redis: RedisClient, latest: TradingDay) {
    const entries = [...latest.twse, ...latest.tpex].map(([id, { name }]) => `${id} ${name}`).sort();
    if(entries.length === 0) return;
    await redis.multi().del(STOCKS).sAdd(STOCKS, entries).set(STOCK_LIST_UPDATED, latest.date).exec();
    log(`stock list of ${latest.date} written: ${entries.length} entries`);
}

/** Returns the latest day on which both markets traded, for the stock list. */
async function syncDividends(db: Db): Promise<TradingDay | undefined> {
    const events = db.collection<TrackedDividendEvent>(EVENT_COLLECTION);
    await events.createIndex({ market: 1, id: 1, date: 1 }, { unique: true });
    const states = db.collection<SyncState>(STATE_COLLECTION);
    const now = taipeiNow();
    const twse = new RateLimitedClient(TWSE_REQUEST_INTERVAL_MS);
    const tpex = new RateLimitedClient(TPEX_REQUEST_INTERVAL_MS);
    const context: SyncContext = {
        events,
        states,
        twse,
        sources: [
            { market: 'twse', firstDate: TWSE_FIRST_DATE, fetchEvents: (start, end) => fetchTwseEvents(twse, start, end), fetchCloses: (date) => fetchTwseCloses(twse, date) },
            { market: 'tpex', firstDate: TPEX_FIRST_DATE, fetchEvents: (start, end) => fetchTpexEvents(tpex, start, end), fetchCloses: (date) => fetchTpexCloses(tpex, date) },
        ],
        firstDate: laterOf(TWSE_FIRST_DATE, process.env.SYNC_START_DATE),
        lastDate: targetDate(now),
        today: now.date,
    };
    const state: SyncState = (await states.findOne({ _id: STATE_ID })) ?? { _id: STATE_ID };
    log(`run started, closing prices checked through ${state.lastCloseDate ?? 'nothing yet'}, target ${context.lastDate}`);

    const newDates = await Promise.all(context.sources.map((source) => readEvents(context, state, source)));
    await rewindForNewEvents(context, state, newDates.flat());
    await readTwseAmounts(context);
    const latest = await checkFills(context, state);
    await publishSummaries(db, context, latest);
    return latest;
}

async function main() {
    const db = await mongodbConnect();
    try {
        const latest = await syncDividends(db);
        if(latest) {
            const redis = await redisConnect({ maxRetries: REDIS_MAX_RETRIES });
            try {
                await publishStockList(redis, latest);
            } finally {
                await redis.quit();
            }
        }
        log('run finished');
    } finally {
        await mongodbDisconnect();
    }
}

main().catch((error) => {
    console.error(`[sync] stopped: ${describeError(error)}`);
    process.exitCode = 1;
});
