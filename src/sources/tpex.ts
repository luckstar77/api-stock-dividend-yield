import { DividendEvent, EventKind, sharesPerShare } from '../dividend/summary';
import { assertFewSkipped, makeRowReader, parseNumber, parseRocDate, SourceFormatError, toCompactDate, toRocSlashDate } from './format';
import { RateLimitedClient } from './rate-limited-client';
import { StockClose } from './twse';

/** Taipei Exchange (上櫃) open data */

const BASE_URL = 'https://www.tpex.org.tw/web/stock';
const STAT_OK = 'ok';
const EVENT_KINDS: Record<string, EventKind> = { '除息': 'cash', '除權': 'stock', '除權息': 'both' };
const EVENT_COLUMNS = ['除權息日期', '代號', '名稱', '除權息前收盤價', '除權息參考價', '息值', '權/息', '每仟股無償配股'] as const;
const CLOSE_COLUMNS = ['代號', '名稱', '收盤'] as const;

interface TpexTable {
    fields?: unknown;
    data?: unknown[][];
}

interface TpexResponse {
    stat?: string;
    date?: string;
    tables?: TpexTable[];
}

/**
 * The TPEx pages answer with the latest day when they do not accept the requested date,
 * so check that the answer is for the date that was asked for.
 */
function readFirstTable(json: unknown, expectedDate: string, page: string): TpexTable {
    if(typeof json !== 'object' || json === null) throw new SourceFormatError(`${page} did not answer with an object`);
    const response = json as TpexResponse;
    if(String(response.stat ?? '').toLowerCase() !== STAT_OK) throw new SourceFormatError(`${page} answered "${response.stat}"`);
    if(response.date !== expectedDate) throw new SourceFormatError(`${page} answered for ${response.date} instead of ${expectedDate}`);
    if(!Array.isArray(response.tables)) throw new SourceFormatError(`${page} answered without tables`);
    // A day without trading comes back as one table with no rows (older days: no table at all).
    // build/sync.js compares with the TWSE answer to tell that apart from a missing day.
    return response.tables[0] ?? {};
}

/** 除權除息計算結果表 */
export function parseTpexEvents(json: unknown, start: string, end: string): DividendEvent[] {
    const table = readFirstTable(json, `${toCompactDate(start)}~${toCompactDate(end)}`, 'exDailyQ');
    if(!table.data || table.data.length === 0) return [];
    const read = makeRowReader(table.fields, EVENT_COLUMNS);
    const events: DividendEvent[] = [];
    for(const row of table.data) {
        const date = parseRocDate(String(read(row, '除權息日期')));
        const preExClose = parseNumber(read(row, '除權息前收盤價'));
        const referencePrice = parseNumber(read(row, '除權息參考價'));
        const cashDividend = parseNumber(read(row, '息值'));
        const sharesPerThousand = parseNumber(read(row, '每仟股無償配股'));
        const kind = EVENT_KINDS[String(read(row, '權/息')).trim()];
        if(!kind || !date || !preExClose || referencePrice === undefined || cashDividend === undefined || sharesPerThousand === undefined) {
            console.warn(`[sync] skipping an exDailyQ row: ${JSON.stringify(row.slice(0, 9))}`);
            continue;
        }
        events.push({
            market: 'tpex',
            id: String(read(row, '代號')).trim(),
            name: String(read(row, '名稱')).trim(),
            date,
            preExClose,
            referencePrice,
            kind,
            cashDividend,
            stockDividendPerShare: sharesPerShare(sharesPerThousand),
        });
    }
    assertFewSkipped(table.data.length - events.length, table.data.length, 'exDailyQ');
    return events;
}

/** 上櫃股票每日收盤行情. Returns null when there was no trading on that day. */
export function parseTpexCloses(json: unknown, isoDate: string): Map<string, StockClose> | null {
    const table = readFirstTable(json, toCompactDate(isoDate), 'stk_wn1430');
    if(!table.data || table.data.length === 0) return null;
    const read = makeRowReader(table.fields, CLOSE_COLUMNS);
    const closes = new Map<string, StockClose>();
    for(const row of table.data) {
        const close = parseNumber(read(row, '收盤'));
        if(close === undefined) continue;
        closes.set(String(read(row, '代號')).trim(), { name: String(read(row, '名稱')).trim(), close });
    }
    return closes;
}

export async function fetchTpexEvents(client: RateLimitedClient, start: string, end: string): Promise<DividendEvent[]> {
    const json = await client.getJson(`${BASE_URL}/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d=${toRocSlashDate(start)}&ed=${toRocSlashDate(end)}`);
    return parseTpexEvents(json, start, end);
}

export async function fetchTpexCloses(client: RateLimitedClient, isoDate: string): Promise<Map<string, StockClose> | null> {
    const json = await client.getJson(`${BASE_URL}/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${toRocSlashDate(isoDate)}&se=EW&o=json`);
    return parseTpexCloses(json, isoDate);
}
