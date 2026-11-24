import { DividendAmount, DividendEvent, EventKind, sharesPerShare } from '../dividend/summary';
import { assertFewSkipped, hasColumn, makeRowReader, parseAmount, parseNumber, parseRocDate, SourceFormatError, toCompactDate } from './format';
import { RateLimitedClient } from './rate-limited-client';

/** Taiwan Stock Exchange (上市) open data */

const BASE_URL = 'https://www.twse.com.tw/rwd/zh';
const STAT_OK = 'ok';
const STAT_NO_DATA = '很抱歉，沒有符合條件的資料!';
/** What the detail page answers for an ex-date it has no data for (both wordings are used, e.g. for 2004) */
const STATS_NO_DETAIL: ReadonlySet<string> = new Set(['無相關資料', '查無相關資料']);
const CLOSES_TABLE_TITLE = '每日收盤行情';
const CASH_DIVIDEND_COLUMN = '現金股利';
const FREE_SHARES_COLUMN = '每千股無償配股';
const EVENT_KINDS: Record<string, EventKind> = { '息': 'cash', '權': 'stock', '權息': 'both' };
const EVENT_COLUMNS = ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息'] as const;
const CLOSE_COLUMNS = ['證券代號', '證券名稱', '收盤價'] as const;
/** Tables up to 2008 also give the cash dividend in a column of its own. */
const CASH_COLUMN = '息值';
const AMOUNT_DECIMALS = 6;

interface TwseTable {
    title?: string;
    fields?: unknown;
    data?: unknown[][];
}

interface TwseResponse extends TwseTable {
    stat?: string;
    date?: string;
    tables?: TwseTable[];
}

export interface StockClose {
    name: string;
    close: number;
}

function asResponse(json: unknown): TwseResponse {
    if(typeof json !== 'object' || json === null) throw new SourceFormatError('the answer is not an object');
    return json as TwseResponse;
}

function isStat(response: TwseResponse, stat: string): boolean {
    return String(response.stat ?? '').toLowerCase() === stat;
}

/**
 * Shares received per share held, worked out from the prices: reference = (pre-ex close − cash) ÷ (1 + shares).
 * A capital increase paid for in cash on the same ex-date cannot be told apart this way.
 */
function deriveSharesPerShare(preExClose: number, referencePrice: number, cashDividend: number): number {
    if(referencePrice <= 0) return 0;
    const shares = (preExClose - cashDividend) / referencePrice - 1;
    return shares > 0 ? Number(shares.toFixed(AMOUNT_DECIMALS)) : 0;
}

/**
 * 除權除息計算結果表 (TWT49U). Ex-dates on which shares were given out get their amounts from
 * {@link parseTwseDetail}, because the table does not tell a stock dividend from a capital increase paid for in cash.
 * The ex-dates of 2004, and a few of 2005, have no detail page; for those the amounts estimated from the table are used.
 */
export function parseTwseEvents(json: unknown): DividendEvent[] {
    const response = asResponse(json);
    if(response.stat === STAT_NO_DATA) return [];
    if(!isStat(response, STAT_OK)) throw new SourceFormatError(`TWT49U answered "${response.stat}"`);
    const read = makeRowReader(response.fields, EVENT_COLUMNS);
    const hasCashColumn = hasColumn(response.fields, CASH_COLUMN);
    const rows = response.data ?? [];
    const events: DividendEvent[] = [];
    for(const row of rows) {
        const date = parseRocDate(String(read(row, '資料日期')));
        const preExClose = parseNumber(read(row, '除權息前收盤價'));
        const referencePrice = parseNumber(read(row, '除權息參考價'));
        const totalValue = parseNumber(read(row, '權值+息值'));
        const kind = EVENT_KINDS[String(read(row, '權/息')).trim()];
        if(!kind || !date || !preExClose || referencePrice === undefined || totalValue === undefined) {
            console.warn(`[sync] skipping a TWT49U row: ${JSON.stringify(row.slice(0, 8))}`);
            continue;
        }
        const isCashOnly = kind === 'cash';
        const tableCash = !isCashOnly && hasCashColumn ? parseNumber(read(row, CASH_COLUMN)) : undefined;
        const estimatedAmount: DividendAmount | undefined = tableCash === undefined ? undefined : {
            cashDividend: tableCash,
            stockDividendPerShare: deriveSharesPerShare(preExClose, referencePrice, tableCash),
        };
        events.push({
            market: 'twse',
            id: String(read(row, '股票代號')).trim(),
            name: String(read(row, '股票名稱')).trim(),
            date,
            preExClose,
            referencePrice,
            kind,
            cashDividend: isCashOnly ? totalValue : null,
            stockDividendPerShare: isCashOnly ? 0 : null,
            ...(estimatedAmount ? { estimatedAmount } : {}),
        });
    }
    assertFewSkipped(rows.length - events.length, rows.length, 'TWT49U');
    return events;
}

/**
 * 除權除息計算結果表的詳細資料 (TWT49UDetail): the cash dividend and the free shares of one ex-date.
 * Returns null only when the page says it has no data for the ex-date (無相關資料 or 查無相關資料); any other unexpected answer throws,
 * so an error page cannot be saved as a zero dividend.
 */
export function parseTwseDetail(json: unknown): DividendAmount | null {
    const response = asResponse(json);
    if(STATS_NO_DETAIL.has(String(response.stat ?? '').trim())) return null;
    if(!isStat(response, STAT_OK)) throw new SourceFormatError(`TWT49UDetail answered "${response.stat}"`);
    const fields = Array.isArray(response.fields) ? response.fields.map((field) => String(field)) : [];
    const cashIndex = fields.findIndex((field) => field.includes(CASH_DIVIDEND_COLUMN));
    const sharesIndex = fields.findIndex((field) => field.includes(FREE_SHARES_COLUMN));
    const row = response.data?.[0];
    if(cashIndex < 0 || sharesIndex < 0 || !row) throw new SourceFormatError('TWT49UDetail has no amounts columns or no row');
    const cashDividend = parseAmount(row[cashIndex]);
    const sharesPerThousand = parseAmount(row[sharesIndex]);
    if(cashDividend === undefined || sharesPerThousand === undefined) {
        throw new SourceFormatError(`TWT49UDetail has amounts that are not numbers: ${row[cashIndex]}, ${row[sharesIndex]}`);
    }
    return { cashDividend, stockDividendPerShare: sharesPerShare(sharesPerThousand) };
}

/** 每日收盤行情 (MI_INDEX). Returns null when there was no trading on that day. */
export function parseTwseCloses(json: unknown, isoDate: string): Map<string, StockClose> | null {
    const response = asResponse(json);
    if(response.stat === STAT_NO_DATA) return null;
    if(!isStat(response, STAT_OK)) throw new SourceFormatError(`MI_INDEX ${isoDate} answered "${response.stat}"`);
    if(response.date !== toCompactDate(isoDate)) throw new SourceFormatError(`MI_INDEX ${isoDate} answered for ${response.date}`);
    const table = response.tables?.find((candidate) => String(candidate.title ?? '').includes(CLOSES_TABLE_TITLE));
    if(!table) throw new SourceFormatError(`MI_INDEX ${isoDate} has no closing prices table`);
    const read = makeRowReader(table.fields, CLOSE_COLUMNS);
    const closes = new Map<string, StockClose>();
    for(const row of table.data ?? []) {
        const close = parseNumber(read(row, '收盤價'));
        if(close === undefined) continue;
        closes.set(String(read(row, '證券代號')).trim(), { name: String(read(row, '證券名稱')).trim(), close });
    }
    return closes;
}

export async function fetchTwseEvents(client: RateLimitedClient, start: string, end: string): Promise<DividendEvent[]> {
    const json = await client.getJson(`${BASE_URL}/exRight/TWT49U?startDate=${toCompactDate(start)}&endDate=${toCompactDate(end)}&response=json`);
    return parseTwseEvents(json);
}

export async function fetchTwseDetail(client: RateLimitedClient, id: string, isoDate: string): Promise<DividendAmount | null> {
    const json = await client.getJson(`${BASE_URL}/exRight/TWT49UDetail?STK_NO=${encodeURIComponent(id)}&T1=${toCompactDate(isoDate)}&response=json`);
    return parseTwseDetail(json);
}

export async function fetchTwseCloses(client: RateLimitedClient, isoDate: string): Promise<Map<string, StockClose> | null> {
    const json = await client.getJson(`${BASE_URL}/afterTrading/MI_INDEX?date=${toCompactDate(isoDate)}&type=ALLBUT0999&response=json`);
    return parseTwseCloses(json, isoDate);
}
