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
import { addDays, isSunday, laterOf, taipeiNow, yearRanges } from './sources/format';
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
/** Hour (Taiwan time) after which today's closing prices are published. Before it, stop at yesterday. */
const CLOSES_READY_HOUR = 17;
/** Read the latest weeks of ex-dividend data again on every run, in case they were corrected. */
const EVENTS_REFETCH_DAYS = 31;
const TWSE_REQUEST_INTERVAL_MS = 3500;
const TPEX_REQUEST_INTERVAL_MS = 3000;
const BULK_WRITE_SIZE = 500;
const PROGRESS_LOG_EVERY = 100;

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
}

function log(message: string) {
    console.log(`[sync] ${message}`);
}

async function bulkWriteInChunks<T extends Document>(collection: Collection<T>, operations: AnyBulkWriteOperation<T>[]) {
    for(let index = 0; index < operations.length; index += BULK_WRITE_SIZE) {
        await collection.bulkWrite(operations.slice(index, index + BULK_WRITE_SIZE), { ordered: false });
    }
}

/** Saves the amounts when the table gives them; otherwise keeps what an earlier run read from the detail page. */
function toEventUpsert(event: DividendEvent): AnyBulkWriteOperation<TrackedDividendEvent> {
    const { market, id, date, cashDividend, stockDividendPerShare, ...published } = event;
    const isAmountKnown = cashDividend !== null && stockDividendPerShare !== null;
    return {
        updateOne: {
            filter: { market, id, date },
            update: {
                $set: isAmountKnown ? { ...published, cashDividend, stockDividendPerShare } : published,
                $setOnInsert: isAmountKnown ? { filledDate: null } : { filledDate: null, cashDividend: null, stockDividendPerShare: null },
            },
            upsert: true,
        },
    };
}

async function readEvents(context: SyncContext, state: SyncState, source: MarketSource) {
    const firstDate = laterOf(source.firstDate, context.firstDate);
    const readThrough = state.eventsReadThrough?.[source.market];
    const start = readThrough ? laterOf(firstDate, addDays(readThrough, -EVENTS_REFETCH_DAYS)) : firstDate;
    for(const range of yearRanges(start, context.lastDate)) {
        const found = await source.fetchEvents(range.start, range.end);
        await bulkWriteInChunks(context.events, found.map(toEventUpsert));
        await context.states.updateOne({ _id: STATE_ID }, { $set: { [`eventsReadThrough.${source.market}`]: range.end } }, { upsert: true });
        log(`${source.market} ex-dividend data ${range.start}..${range.end}: ${found.length} rows`);
    }
}

async function readTwseAmounts(context: SyncContext) {
    const pending = await context.events.find({ market: 'twse', cashDividend: null }).sort({ date: 1 }).toArray();
    let missing = 0;
    for(const [index, event] of pending.entries()) {
        const amount = await fetchTwseDetail(context.twse, event.id, event.date);
        if(amount) {
            await context.events.updateOne({ _id: event._id }, { $set: amount });
        } else {
            // Not asked again on later runs; the event is left out of the summary.
            missing++;
            await context.events.updateOne({ _id: event._id }, { $set: { cashDividend: 0, stockDividendPerShare: 0, amountUnavailable: true } });
            console.warn(`[sync] the detail page has no amounts for ${event.id} on ${event.date}; leaving it out`);
        }
        if((index + 1) % PROGRESS_LOG_EVERY === 0) log(`dividend amounts ${index + 1}/${pending.length}`);
    }
    log(`dividend amounts read for ${pending.length - missing} ex-dates, ${missing} without amounts`);
}

async function readClosesOfDay(context: SyncContext, date: string): Promise<Partial<Record<Market, Map<string, StockClose>>>> {
    const answers = await Promise.all(context.sources.map((source) => (date >= source.firstDate ? source.fetchCloses(date) : null)));
    const closes: Partial<Record<Market, Map<string, StockClose>>> = {};
    context.sources.forEach((source, index) => {
        const answer = answers[index];
        if(answer) closes[source.market] = answer;
    });
    return closes;
}

function toPriceMap(closes: Partial<Record<Market, Map<string, StockClose>>>): Map<string, number> {
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
    let checkedDays = 0;
    const start = state.lastCloseDate ? addDays(state.lastCloseDate, 1) : context.firstDate;
    for(let date = start; date <= context.lastDate; date = addDays(date, 1)) {
        if(isSunday(date)) continue;
        const closes = await readClosesOfDay(context, date);
        const marketsTraded = Object.keys(closes).length;
        if(marketsTraded > 0) {
            const filled = findFilledEvents(open, date, toPriceMap(closes));
            if(filled.length > 0) {
                await bulkWriteInChunks(context.events, filled.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $set: { filledDate: date } } } })));
                const filledIds = new Set(filled.map((event) => event._id.toHexString()));
                open = open.filter((event) => !filledIds.has(event._id.toHexString()));
            }
            if(closes.twse && closes.tpex) latest = { date, twse: closes.twse, tpex: closes.tpex };
            else if(date >= TPEX_FIRST_DATE) console.warn(`[sync] ${date}: only one market has closing prices`);
        }
        await context.states.updateOne({ _id: STATE_ID }, { $set: { lastCloseDate: date } }, { upsert: true });
        if(++checkedDays % PROGRESS_LOG_EVERY === 0) log(`closing prices checked through ${date}, ${open.length} ex-dates not filled yet`);
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

async function syncDividends(db: Db, redis: RedisClient) {
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
        lastDate: now.hour >= CLOSES_READY_HOUR ? now.date : addDays(now.date, -1),
    };
    const state: SyncState = (await states.findOne({ _id: STATE_ID })) ?? { _id: STATE_ID };
    log(`run started, closing prices checked through ${state.lastCloseDate ?? 'nothing yet'}, target ${context.lastDate}`);

    await Promise.all(context.sources.map((source) => readEvents(context, state, source)));
    await readTwseAmounts(context);
    const latest = await checkFills(context, state);
    await publishSummaries(db, context, latest);
    if(latest) await publishStockList(redis, latest);
    log('run finished');
}

async function main() {
    const db = await mongodbConnect();
    const redis = await redisConnect();
    try {
        await syncDividends(db, redis);
    } finally {
        await redis.quit();
        await mongodbDisconnect();
    }
}

main().catch((error) => {
    console.error(`[sync] stopped: ${describeError(error)}`);
    process.exitCode = 1;
});
