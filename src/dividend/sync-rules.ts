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
 */
export function toEventUpsert(event: DividendEvent): AnyBulkWriteOperation<TrackedDividendEvent> {
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

export function judgeDay(expectedMarkets: readonly Market[], tradedMarkets: readonly Market[], date: string, today: string): DayVerdict {
    if(tradedMarkets.length === 0) return 'holiday';
    if(expectedMarkets.every((market) => tradedMarkets.includes(market))) return 'trading';
    return date >= addDays(today, -ONE_MARKET_RETRY_DAYS) ? 'retry-later' : 'one-market';
}

/**
 * An ex-date that first appears on a day already checked has to be checked from its ex-date on.
 * Checking a day again is safe: events filled earlier stay filled, and open ones get the same answer.
 */
export function rewindCheckpoint(lastCloseDate: string | undefined, newEventDates: readonly string[]): string | undefined {
    if(!lastCloseDate || newEventDates.length === 0) return lastCloseDate;
    const earliest = newEventDates.reduce((first, date) => (date < first ? date : first));
    return earliest <= lastCloseDate ? addDays(earliest, -1) : lastCloseDate;
}
