import { buildDividendYears, DividendYear, trailingCashDividend } from '../dividend/history';
import { Market } from '../dividend/summary';
import { taipeiNow } from '../sources/format';
import { StockDocument, StockRepository } from '../repositories/stock-repository';
import { StockListRepository } from '../repositories/stock-list-repository';

const PERCENT = 100;
const ENTRY_SEPARATOR = ' ';
const HEALTH_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface StockListItem {
    idString: string;
    name: string;
}

export interface StockList {
    list: StockListItem[];
    listDate: string | null;
}

export interface StockDividends {
    idString: string;
    name: string;
    market: Market | null;
    successRatio: number;
    avgCashYieldRatio: number;
    avgRetroactiveYieldRatio: number;
    dividendYearCount: number;
    filledYearCount: number;
    dividendYearStart: number;
    dividendYearEnd: number;
    dataThroughDate: string | null;
    updatedAt: string | null;
    lastClose: number | null;
    lastCloseDate: string | null;
    trailingCashDividend: number;
    trailingCashYieldRatio: number | null;
    /** Newest year first */
    years: DividendYear[];
}

export interface HealthStatus {
    mongodb: 'up';
    redis: 'up';
}

/** The front-end calls toFixed() on these three, so all of them have to be real numbers. */
export function hasDividendSummary(stock: StockDocument): boolean {
    const { successRate, allAvgCashYields, allAvgRetroactiveYields } = stock;
    return [successRate, allAvgCashYields, allAvgRetroactiveYields].every((value) => Number.isFinite(value));
}

/** '2330 台積電' → { idString: '2330', name: '台積電' }. Only the first space separates them; names may contain spaces. */
export function parseStockEntry(entry: string): StockListItem {
    const separatorIndex = entry.indexOf(ENTRY_SEPARATOR);
    if(separatorIndex === -1) return { idString: entry, name: '' };
    return { idString: entry.slice(0, separatorIndex), name: entry.slice(separatorIndex + 1) };
}

function toFiniteNumber(value: unknown): number | null {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function toStringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function toIsoDateTime(value: unknown): string | null {
    if(value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    return toStringOrNull(value);
}

export interface StockServiceOptions {
    /** Lets tests fix "today" */
    now?: () => Date;
    healthTimeoutMs?: number;
}

export class StockService {
    private readonly now: () => Date;
    private readonly healthTimeoutMs: number;

    constructor(
        private readonly stockRepository: StockRepository,
        private readonly stockListRepository: StockListRepository,
        options: StockServiceOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    }

    /** A database that holds the connection open without answering would otherwise keep the check waiting for ever. */
    async checkHealth(): Promise<HealthStatus> {
        await withTimeout(Promise.all([this.stockRepository.ping(), this.stockListRepository.ping()]), this.healthTimeoutMs, 'health check');
        return { mongodb: 'up', redis: 'up' };
    }

    /** The search box list, sorted by id. */
    async getStockList(): Promise<StockList> {
        const [entries, listDate] = await Promise.all([this.stockListRepository.findEntries(), this.stockListRepository.findListDate()]);
        const list = entries.map(parseStockEntry).sort((first, second) => first.idString.localeCompare(second.idString));
        return { list, listDate: list.length === 0 ? null : toStringOrNull(listDate) };
    }

    /** The raw entries, as the legacy GET /stocks has always answered them. */
    getLegacyStockEntries(): Promise<string[]> {
        return this.stockListRepository.findEntries();
    }

    /** The stored document, as the legacy GET /stock has always answered it; null when it has no usable summary. */
    async findLegacyStock(keyword: string): Promise<StockDocument | null> {
        const stock = await this.stockRepository.findStockByKeyword(keyword);
        return stock !== null && hasDividendSummary(stock) ? stock : null;
    }

    /** Returns null when the stock is unknown or has no usable summary. */
    async getStockDividends(keyword: string): Promise<StockDividends | null> {
        const stock = await this.findLegacyStock(keyword);
        if(stock === null) return null;

        const idString = String(stock.id);
        const events = await this.stockRepository.findDividendEvents(idString);
        const years = buildDividendYears(events);
        const lastClose = toFiniteNumber(stock.lastClose);
        const lastCloseDate = toStringOrNull(stock.lastCloseDate);
        const dataThroughDate = toStringOrNull(stock.dataThrough);
        const asOfDate = lastCloseDate ?? dataThroughDate ?? taipeiNow(this.now()).date;
        const trailing = trailingCashDividend(events, asOfDate);
        const oldestYear = years.length > 0 ? years[years.length - 1].year : 0;
        const newestYear = years.length > 0 ? years[0].year : 0;

        return {
            idString,
            name: String(stock.name ?? ''),
            market: events.length > 0 ? events[events.length - 1].market : null,
            successRatio: Number(stock.successRate),
            avgCashYieldRatio: Number(stock.allAvgCashYields),
            avgRetroactiveYieldRatio: Number(stock.allAvgRetroactiveYields),
            dividendYearCount: toFiniteNumber(stock.amountOfDividend) ?? 0,
            filledYearCount: toFiniteNumber(stock.amountOfSuccess) ?? 0,
            dividendYearStart: toFiniteNumber(stock.dividendYearStart) ?? oldestYear,
            dividendYearEnd: toFiniteNumber(stock.dividendYearEnd) ?? newestYear,
            dataThroughDate,
            updatedAt: toIsoDateTime(stock.updated),
            lastClose,
            lastCloseDate,
            trailingCashDividend: trailing,
            trailingCashYieldRatio: lastClose !== null && lastClose > 0 ? (trailing / lastClose) * PERCENT : null,
            years,
        };
    }
}
