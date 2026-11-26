import { addDays } from '../sources/format';
import { cashYield, EventKind, isDividend, isDividendKnown, retroactiveYield, TrackedDividendEvent } from './summary';

/**
 * The year-by-year dividend history the front-end shows under the summary.
 * Built from the dividend_event collection with the same rules as summarizeDividends:
 * only ex-dates whose amounts are known and that paid a dividend count.
 */

const PERCENT = 100;
/** A stock dividend is quoted in NT$ per share of NT$10 face value: 1 free share per 10 held = NT$1. */
const FACE_VALUE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRAILING_DAYS = 365;

export interface DividendEventItem {
    exDate: string;
    kind: EventKind;
    preExClose: number;
    referencePrice: number;
    /** NT$ per share */
    cashDividend: number;
    /** NT$ per share of NT$10 face value */
    stockDividend: number;
    filledDate: string | null;
    /** Calendar days from the ex-date to the fill; 0 when filled on the ex-date */
    fillDayCount: number | null;
    isAmountEstimated: boolean;
}

export interface DividendYear {
    year: number;
    cashDividend: number;
    stockDividend: number;
    /** In percent, the sum of the year's per-event cash yields */
    cashYieldRatio: number;
    /** In percent, the sum of the year's per-event retroactive yields */
    retroactiveYieldRatio: number;
    /** Every ex-date of the year was filled */
    isFilled: boolean;
    /** Oldest first */
    events: DividendEventItem[];
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function daysBetween(fromIsoDate: string, toIsoDate: string): number {
    return Math.round((Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / DAY_MS);
}

function isCounted(event: TrackedDividendEvent): boolean {
    return isDividendKnown(event) && isDividend(event);
}

function toEventItem(event: TrackedDividendEvent): DividendEventItem {
    return {
        exDate: event.date,
        kind: event.kind,
        preExClose: event.preExClose,
        referencePrice: event.referencePrice,
        cashDividend: event.cashDividend ?? 0,
        stockDividend: (event.stockDividendPerShare ?? 0) * FACE_VALUE,
        filledDate: event.filledDate,
        fillDayCount: event.filledDate === null ? null : daysBetween(event.date, event.filledDate),
        isAmountEstimated: event.amountEstimated === true,
    };
}

/** Groups the counted ex-dates by calendar year, newest year first and the ex-dates of a year oldest first. */
export function buildDividendYears(events: readonly TrackedDividendEvent[]): DividendYear[] {
    const years = new Map<number, TrackedDividendEvent[]>();
    for(const event of events.filter(isCounted)) {
        const year = Number(event.date.slice(0, 4));
        const list = years.get(year) ?? [];
        list.push(event);
        years.set(year, list);
    }

    return [...years.entries()]
        .sort(([firstYear], [secondYear]) => secondYear - firstYear)
        .map(([year, list]) => {
            const sorted = [...list].sort((first, second) => first.date.localeCompare(second.date));
            const items = sorted.map(toEventItem);
            return {
                year,
                cashDividend: sum(items.map((item) => item.cashDividend)),
                stockDividend: sum(items.map((item) => item.stockDividend)),
                cashYieldRatio: sum(sorted.map(cashYield)) * PERCENT,
                retroactiveYieldRatio: sum(sorted.map(retroactiveYield)) * PERCENT,
                isFilled: sorted.every((event) => event.filledDate !== null),
                events: items,
            };
        });
}

/** Cash dividends of the counted ex-dates in the 365 days up to and including asOfDate (YYYY-MM-DD). */
export function trailingCashDividend(events: readonly TrackedDividendEvent[], asOfDate: string): number {
    const windowStart = addDays(asOfDate, -TRAILING_DAYS);
    return sum(events
        .filter((event) => isCounted(event) && event.date > windowStart && event.date <= asOfDate)
        .map((event) => event.cashDividend ?? 0));
}
