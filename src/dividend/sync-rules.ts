import { AnyBulkWriteOperation } from 'mongodb';
import { addDays, isSunday, laterOf } from '../sources/format';
import { DividendEvent, Market, TrackedDividendEvent } from './summary';

/** Rules of build/sync.js that decide which days to read and how to save, kept apart so they can be tested. */

/** Hour (Taiwan time) after which today's closing prices are published. Before it, stop at yesterday. */
export const CLOSES_READY_HOUR = 17;
/** Read the latest weeks of ex-dividend data again on every run, in case they were corrected or added late. */
export const EVENTS_REFETCH_DAYS = 31;
/**
 * A day on which only one market has closing prices is tried again on a later run while it is this recent.
 * An older gap will not be filled in by trying again, so it is accepted with a warning.
 */
export const ONE_MARKET_RETRY_DAYS = 7;
/**
 * A single old day whose closing prices page cannot be read is skipped for that market. This many days in a row
 * look like the site answering with errors (for example throttling), so the run stops and checks them again later.
 */
export const MAX_UNREADABLE_DAYS_IN_A_ROW = 3;

/** holiday: no market traded. trading: every market that should have prices has them. */
export type DayVerdict = 'holiday' | 'trading' | 'retry-later' | 'one-market';

/** The last day whose closing prices can be checked now. */
export function targetDate(now: { date: string; hour: number }): string {
    return now.hour >= CLOSES_READY_HOUR ? now.date : addDays(now.date, -1);
}

/** The days after the last checked one, up to the target. Sundays are left out; some Saturdays were trading days. */
export function datesToCheck(lastCloseDate: string | undefined, firstDate: string, lastDate: string): string[] {
    const dates: string[] = [];
    const start = lastCloseDate ? laterOf(firstDate, addDays(lastCloseDate, 1)) : firstDate;
    for(let date = start; date <= lastDate; date = addDays(date, 1)) {
        if(!isSunday(date)) dates.push(date);
    }
    return dates;
}

export function eventsReadStart(readThrough: string | undefined, firstDate: string): string {
    return readThrough ? laterOf(firstDate, addDays(readThrough, -EVENTS_REFETCH_DAYS)) : firstDate;
}

/**
 * Saves the amounts when the table gives them; otherwise keeps what an earlier run read from the detail page.
 * filledDate is set only when the event is first saved, so reading the table again never clears it.
 * An event first saved with an ex-date on a day already checked (checkedThrough) is flagged needsRecheck
 * in the same write, so the flag survives a run that stops right after it.
 */
export function toEventUpsert(event: DividendEvent, checkedThrough?: string): AnyBulkWriteOperation<TrackedDividendEvent> {
    const { market, id, date, cashDividend, stockDividendPerShare, ...published } = event;
    const isAmountKnown = cashDividend !== null && stockDividendPerShare !== null;
    const needsRecheck = checkedThrough !== undefined && date <= checkedThrough;
    return {
        updateOne: {
            filter: { market, id, date },
            update: {
                $set: isAmountKnown ? { ...published, cashDividend, stockDividendPerShare } : published,
                $setOnInsert: {
                    filledDate: null,
                    ...(isAmountKnown ? {} : { cashDividend: null, stockDividendPerShare: null }),
                    ...(needsRecheck ? { needsRecheck } : {}),
                },
            },
            upsert: true,
        },
    };
}

/** A day this old will not change by asking again, so a gap in it is accepted with a warning. */
export function isSettled(date: string, today: string): boolean {
    return date < addDays(today, -ONE_MARKET_RETRY_DAYS);
}

export function judgeDay(expectedMarkets: readonly Market[], tradedMarkets: readonly Market[], date: string, today: string): DayVerdict {
    if(tradedMarkets.length === 0) return 'holiday';
    if(expectedMarkets.every((market) => tradedMarkets.includes(market))) return 'trading';
    return isSettled(date, today) ? 'one-market' : 'retry-later';
}

/** Per market, the days in a row (up to the latest one checked) whose closing prices page could not be read */
export type UnreadableStreaks = Partial<Record<Market, string[]>>;

/** Adds one checked day to the streaks and returns the markets whose streak has become too long. */
export function trackUnreadableDays(streaks: UnreadableStreaks, markets: readonly Market[], unreadable: readonly Market[], date: string) {
    const next: UnreadableStreaks = {};
    for(const market of markets) next[market] = unreadable.includes(market) ? [...(streaks[market] ?? []), date] : [];
    const tooLong = unreadable.filter((market) => (next[market] ?? []).length >= MAX_UNREADABLE_DAYS_IN_A_ROW);
    return { streaks: next, tooLong };
}

/**
 * An ex-date that first appears on a day already checked has to be checked from its ex-date on.
 * Checking a day again is safe: events filled earlier stay filled, and open ones get the same answer.
 */
export function rewindCheckpoint(lastCloseDate: string | undefined, recheckDates: readonly string[]): string | undefined {
    if(!lastCloseDate || recheckDates.length === 0) return lastCloseDate;
    const earliest = recheckDates.reduce((first, date) => (date < first ? date : first));
    return earliest <= lastCloseDate ? addDays(earliest, -1) : lastCloseDate;
}
