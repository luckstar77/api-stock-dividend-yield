export type Market = 'twse' | 'tpex';

/** cash: 除息, stock: 除權, both: 除權息 */
export type EventKind = 'cash' | 'stock' | 'both';

export interface DividendAmount {
    cashDividend: number;
    stockDividendPerShare: number;
}

/** One ex-rights or ex-dividend day of one stock, as the exchange published it. */
export interface DividendEvent {
    market: Market;
    id: string;
    name: string;
    /** The ex-date, YYYY-MM-DD */
    date: string;
    /** Closing price on the trading day before the ex-date */
    preExClose: number;
    /** Reference price the exchange set for the ex-date */
    referencePrice: number;
    kind: EventKind;
    /** Cash dividend per share; null until known */
    cashDividend: number | null;
    /** Free shares received per share held (每千股無償配股 ÷ 1000); null until known */
    stockDividendPerShare: number | null;
    /**
     * Amounts worked out from the table (TWSE up to 2008, which gives the cash dividend in a column of its own).
     * Used only when the detail page has no data, because they cannot tell a stock dividend from a capital
     * increase paid for in cash.
     */
    estimatedAmount?: DividendAmount;
}

export interface TrackedDividendEvent extends DividendEvent {
    /** First trading day on which the stock closed at the pre-ex close or above; null while not filled */
    filledDate: string | null;
    /** The detail page had no data and the amounts were taken from estimatedAmount. */
    amountEstimated?: boolean;
    /** Neither the detail page nor the table gave the amounts; the event is saved with zero amounts and not counted. */
    amountUnavailable?: boolean;
    /** Times the detail page answered something that could not be read; only used to ask the other ex-dates first */
    detailFailures?: number;
    /** First saved after its ex-date had already been checked; cleared once the checkpoint is moved back */
    needsRecheck?: boolean;
}

export interface DividendSummary {
    /** Percentage of years in which every ex-date was filled */
    successRate: number;
    /** Average of the yearly cash yields, in percent */
    allAvgCashYields: number;
    /** Average of the yearly yields counting the shares received at the ex-date reference price, in percent */
    allAvgRetroactiveYields: number;
    /** Number of years with an ex-date */
    amountOfDividend: number;
    /** Number of those years in which every ex-date was filled */
    amountOfSuccess: number;
    dividendYearStart: number;
    dividendYearEnd: number;
}

const PERCENT = 100;
const SHARES_PER_LOT = 1000;

export function sharesPerShare(sharesPerThousand: number): number {
    return sharesPerThousand / SHARES_PER_LOT;
}

function isDividendKnown(event: DividendEvent): boolean {
    return event.cashDividend !== null && event.stockDividendPerShare !== null;
}

/** A capital increase paid for in cash (現金增資) is also published as 除權, but it is not a dividend. */
function isDividend(event: DividendEvent): boolean {
    return (event.cashDividend ?? 0) > 0 || (event.stockDividendPerShare ?? 0) > 0;
}

function cashYield(event: DividendEvent): number {
    return (event.cashDividend ?? 0) / event.preExClose;
}

function retroactiveYield(event: DividendEvent): number {
    const stockValue = (event.stockDividendPerShare ?? 0) * event.referencePrice;
    return ((event.cashDividend ?? 0) + stockValue) / event.preExClose;
}

function average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function groupByYear(events: TrackedDividendEvent[]): Map<number, TrackedDividendEvent[]> {
    const years = new Map<number, TrackedDividendEvent[]>();
    for(const event of events) {
        const year = Number(event.date.slice(0, 4));
        const list = years.get(year) ?? [];
        list.push(event);
        years.set(year, list);
    }
    return years;
}

/**
 * Summarizes one stock's ex-dates the way the front-end shows them: a year counts as filled
 * only when every ex-date in it was filled, and the yields are averaged over the years.
 * Returns undefined while a dividend amount is still unknown, or when the stock never paid a dividend.
 */
export function summarizeDividends(events: readonly TrackedDividendEvent[]): DividendSummary | undefined {
    if(!events.every(isDividendKnown)) return undefined;
    const years = groupByYear(events.filter(isDividend));
    if(years.size === 0) return undefined;

    const yearList = [...years.keys()].sort((first, second) => first - second);
    const yearEvents = yearList.map((year) => years.get(year) ?? []);
    const amountOfDividend = yearList.length;
    const amountOfSuccess = yearEvents.filter((list) => list.every((event) => event.filledDate !== null)).length;
    return {
        successRate: (amountOfSuccess / amountOfDividend) * PERCENT,
        allAvgCashYields: average(yearEvents.map((list) => sum(list.map(cashYield)))) * PERCENT,
        allAvgRetroactiveYields: average(yearEvents.map((list) => sum(list.map(retroactiveYield)))) * PERCENT,
        amountOfDividend,
        amountOfSuccess,
        dividendYearStart: yearList[0],
        dividendYearEnd: yearList[yearList.length - 1],
    };
}

/** Returns the open events whose stock closed at or above the pre-ex close on this trading day. */
export function findFilledEvents<T extends DividendEvent>(openEvents: readonly T[], date: string, closes: ReadonlyMap<string, number>): T[] {
    return openEvents.filter((event) => {
        if(event.date > date) return false;
        const close = closes.get(event.id);
        return close !== undefined && close >= event.preExClose;
    });
}
