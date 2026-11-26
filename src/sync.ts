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
import { ClosesSource, DayCloses, readClosesOfDay } from './dividend/closes';
import { DividendAmount, DividendEvent, findFilledEvents, Market, summarizeDividends, TrackedDividendEvent } from './dividend/summary';
import { datesToCheck, eventsReadStart, rewindCheckpoint, targetDate, toEventUpsert, toStockSummarySet, trackUnreadableDays, UnreadableStreaks } from './dividend/sync-rules';
import { addDays, laterOf, SourceFormatError, taipeiNow, yearRanges } from './sources/format';
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
/** This many unreadable detail pages in a row look like the site answering with errors: the rest wait for the next run. */
const MAX_UNREADABLE_IN_A_ROW = 5;

interface SyncState {
    _id: string;
    /** The last day whose closing prices were checked */
    lastCloseDate?: string;
    /** The last day whose ex-dividend data was read, per market */
    eventsReadThrough?: Partial<Record<Market, string>>;
    /** Old days on which a market's closing prices page could not be read; their fills were checked without that market */
    unreadableCloseDays?: string[];
}

interface MarketSource extends ClosesSource {
    fetchEvents: (start: string, end: string) => Promise<DividendEvent[]>;
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

interface CheckResult {
    /** The latest day on which both markets traded, for the stock list */
    latest?: TradingDay;
    /** The last day whose closing prices have been checked */
    checkedThrough?: string;
}

function log(message: string) {
    console.log(`[sync] ${message}`);
}

async function bulkWriteInChunks<T extends Document>(collection: Collection<T>, operations: AnyBulkWriteOperation<T>[]) {
    for(let index = 0; index < operations.length; index += BULK_WRITE_SIZE) {
        await collection.bulkWrite(operations.slice(index, index + BULK_WRITE_SIZE), { ordered: false });
    }
}

async function readEvents(context: SyncContext, state: SyncState, source: MarketSource) {
    const firstDate = laterOf(source.firstDate, context.firstDate);
    for(const range of yearRanges(eventsReadStart(state.eventsReadThrough?.[source.market], firstDate), context.lastDate)) {
        const found = await source.fetchEvents(range.start, range.end);
        await bulkWriteInChunks(context.events, found.map((event) => toEventUpsert(event, state.lastCloseDate)));
        await context.states.updateOne({ _id: STATE_ID }, { $set: { [`eventsReadThrough.${source.market}`]: range.end } }, { upsert: true });
        log(`${source.market} ex-dividend data ${range.start}..${range.end}: ${found.length} rows`);
    }
}

/**
 * Ex-dates first saved on days already checked (flagged needsRecheck when saved): move the checkpoint back
 * so they are checked from their ex-date on. The flags are cleared only after the checkpoint is saved,
 * so a run that stops in between moves it back again, which is harmless.
 */
async function rewindForLateEvents(context: SyncContext, state: SyncState) {
    const late = await context.events.find({ needsRecheck: true }, { projection: { date: 1 } }).toArray();
    const rewound = rewindCheckpoint(state.lastCloseDate, late.map((event) => event.date));
    if(rewound !== state.lastCloseDate) {
        log(`${late.length} ex-dates appeared after their day was checked; checking again from ${rewound} on`);
        await context.states.updateOne({ _id: STATE_ID }, { $set: { lastCloseDate: rewound } });
        state.lastCloseDate = rewound;
    }
    if(late.length > 0) await context.events.updateMany({ needsRecheck: true }, { $unset: { needsRecheck: '' } });
}

/** Returns undefined when the page answered something that could not be read; the event is asked again on the next run. */
async function readDetail(context: SyncContext, event: WithId<TrackedDividendEvent>): Promise<DividendAmount | null | undefined> {
    try {
        return await fetchTwseDetail(context.twse, event.id, event.date);
    } catch (error) {
        if(!(error instanceof SourceFormatError)) throw error;
        console.warn(`[sync] the detail page for ${event.id} on ${event.date} could not be read, asking again on the next run: ${describeError(error)}`);
        await context.events.updateOne({ _id: event._id }, { $inc: { detailFailures: 1 } });
        return undefined;
    }
}

async function saveAmount(context: SyncContext, event: WithId<TrackedDividendEvent>, detail: DividendAmount | null): Promise<'detail' | 'estimated' | 'missing'> {
    const amount = detail ?? event.estimatedAmount;
    if(!amount) {
        // The page says it has no data and the table gives no estimate: left out of the summary, not asked again.
        await context.events.updateOne({ _id: event._id }, { $set: { cashDividend: 0, stockDividendPerShare: 0, amountUnavailable: true } });
        console.warn(`[sync] no amounts for ${event.id} on ${event.date}, neither on the detail page nor in the table; leaving it out`);
        return 'missing';
    }
    await context.events.updateOne({ _id: event._id }, { $set: { ...amount, amountEstimated: !detail } });
    return detail ? 'detail' : 'estimated';
}

/**
 * Reads the amounts of the TWSE ex-dates on which shares were given out. A page that cannot be read is never
 * saved as an amount: the event waits for the next run, and its stock keeps its previous summary until then.
 */
async function readTwseAmounts(context: SyncContext) {
    // Ex-dates whose page could not be read before go last, so a page that keeps failing cannot hold up the others.
    const pending = await context.events.find({ market: 'twse', cashDividend: null }).sort({ detailFailures: 1, date: 1 }).toArray();
    const counts = { detail: 0, estimated: 0, missing: 0, unreadable: 0 };
    let unreadableInARow = 0;
    for(const [index, event] of pending.entries()) {
        if((index + 1) % PROGRESS_LOG_EVERY === 0) log(`dividend amounts ${index + 1}/${pending.length}`);
        const detail = await readDetail(context, event);
        if(detail !== undefined) {
            counts[await saveAmount(context, event, detail)]++;
            unreadableInARow = 0;
            continue;
        }
        counts.unreadable++;
        unreadableInARow++;
        if(unreadableInARow >= MAX_UNREADABLE_IN_A_ROW) {
            console.warn(`[sync] ${unreadableInARow} detail pages in a row could not be read; the other ${pending.length - index - 1} ex-dates wait for the next run`);
            break;
        }
    }
    log(`dividend amounts of ${pending.length} ex-dates: ${counts.detail} from the detail page, ${counts.estimated} estimated from the table, `
        + `${counts.missing} without amounts, ${counts.unreadable} could not be read`);
}

/**
 * Records an old day on which a market's closing prices page could not be read. When a market could not be read on
 * several days in a row, the checkpoint goes back to the day before the first of them and the run stops before this
 * day is used, so systemd checks those days again in 30 minutes.
 */
async function noteUnreadableDay(context: SyncContext, streaks: UnreadableStreaks, date: string, unreadable: Market[]): Promise<UnreadableStreaks> {
    const markets = context.sources.map((source) => source.market);
    const tracked = trackUnreadableDays(streaks, markets, unreadable, date);
    if(tracked.tooLong.length > 0) {
        const days = tracked.tooLong.flatMap((market) => (tracked.streaks[market] ?? []).map((day) => ({ day, market })));
        const first = days.map(({ day }) => day).sort()[0];
        await context.states.updateOne({ _id: STATE_ID }, {
            $set: { lastCloseDate: addDays(first, -1) },
            $pull: { unreadableCloseDays: { $in: days.map(({ day, market }) => `${day} ${market}`) } },
        });
        throw new Error(`the closing prices page of ${tracked.tooLong.join(', ')} could not be read on several days in a row from ${first}; checking again from that day`);
    }
    if(unreadable.length > 0) {
        console.warn(`[sync] ${date}: the closing prices page of ${unreadable.join(', ')} could not be read; checking that day without it`);
        await context.states.updateOne({ _id: STATE_ID }, { $addToSet: { unreadableCloseDays: { $each: unreadable.map((market) => `${date} ${market}`) } } });
    }
    return tracked.streaks;
}

function toPriceMap(closes: DayCloses): Map<string, number> {
    const prices = new Map<string, number>();
    for(const marketCloses of Object.values(closes)) {
        for(const [id, { close }] of marketCloses ?? []) prices.set(id, close);
    }
    return prices;
}

/**
 * Checks the closing prices of every day since the last checked one. A recent day on which a market has
 * no prices yet ends the checks there; the next scheduled run tries that day again.
 */
async function checkFills(context: SyncContext, state: SyncState): Promise<CheckResult> {
    let open: WithId<TrackedDividendEvent>[] = await context.events.find({ filledDate: null }).toArray();
    let latest: TradingDay | undefined;
    let streaks: UnreadableStreaks = {};
    for(const [index, date] of datesToCheck(state.lastCloseDate, context.firstDate, context.lastDate).entries()) {
        const { closes, verdict, unreadable } = await readClosesOfDay(context.sources, date, context.today);
        streaks = await noteUnreadableDay(context, streaks, date, unreadable);
        if(verdict === 'retry-later') {
            console.warn(`[sync] ${date}: not every market has closing prices yet; stopping at the day before, the next run tries again`);
            break;
        }
        if(verdict === 'one-market') console.warn(`[sync] ${date}: only some markets have closing prices; going on without the others`);
        const filled = findFilledEvents(open, date, toPriceMap(closes));
        if(filled.length > 0) {
            await bulkWriteInChunks(context.events, filled.map((event) => ({ updateOne: { filter: { _id: event._id }, update: { $set: { filledDate: date } } } })));
            const filledIds = new Set(filled.map((event) => event._id.toHexString()));
            open = open.filter((event) => !filledIds.has(event._id.toHexString()));
        }
        if(closes.twse && closes.tpex) latest = { date, twse: closes.twse, tpex: closes.tpex };
        // Saved after the fills, so a run that stops in between checks the day again; that is safe.
        await context.states.updateOne({ _id: STATE_ID }, { $set: { lastCloseDate: date } }, { upsert: true });
        state.lastCloseDate = date;
        if((index + 1) % PROGRESS_LOG_EVERY === 0) log(`closing prices checked through ${date}, ${open.length} ex-dates not filled yet`);
    }
    log(`closing prices checked through ${state.lastCloseDate}, ${open.length} ex-dates not filled yet`);
    return { latest, checkedThrough: state.lastCloseDate };
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

async function publishSummaries(db: Db, context: SyncContext, { latest, checkedThrough }: CheckResult) {
    const events = await context.events.find({}, { projection: { _id: 0 } }).sort({ date: 1 }).toArray();
    const operations: AnyBulkWriteOperation[] = [];
    let waiting = 0;
    for(const [id, stockEvents] of groupById(events)) {
        // A stock with an ex-date whose amounts are not known yet keeps its previous summary.
        if(stockEvents.some((event) => event.cashDividend === null)) {
            waiting++;
            continue;
        }
        const summary = summarizeDividends(stockEvents);
        if(!summary) continue;
        const close = latest?.twse.get(id) ?? latest?.tpex.get(id);
        const name = close?.name ?? stockEvents[stockEvents.length - 1].name;
        const latestClose = latest && close ? { date: latest.date, close: close.close } : undefined;
        operations.push({
            updateOne: {
                filter: { id },
                update: { $set: toStockSummarySet({ name, summary, source: SOURCE, dataThrough: checkedThrough, updated: new Date(), latestClose }) },
                upsert: true,
            },
        });
    }
    await bulkWriteInChunks(db.collection(STOCK_COLLECTION), operations);
    log(`summaries written for ${operations.length} stocks; ${waiting} stocks wait for dividend amounts`);
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

    await Promise.all(context.sources.map((source) => readEvents(context, state, source)));
    await rewindForLateEvents(context, state);
    await readTwseAmounts(context);
    const result = await checkFills(context, state);
    await publishSummaries(db, context, result);
    return result.latest;
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
                // A failure to close must not hide the error that got here.
                await redis.quit().catch((error) => console.warn(`[sync] closing Redis: ${describeError(error)}`));
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
