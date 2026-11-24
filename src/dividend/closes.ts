import { SourceFormatError } from '../sources/format';
import { StockClose } from '../sources/twse';
import { Market } from './summary';
import { DayVerdict, isSettled, judgeDay } from './sync-rules';

export interface ClosesSource {
    market: Market;
    /** The first day this market has closing prices for */
    firstDate: string;
    /** Returns null when the market did not trade on that day */
    fetchCloses: (date: string) => Promise<Map<string, StockClose> | null>;
}

export type DayCloses = Partial<Record<Market, Map<string, StockClose>>>;

export interface DayReading {
    closes: DayCloses;
    verdict: DayVerdict;
    /** Markets whose page for an old day answered something that could not be read, even when asked again */
    unreadable: Market[];
}

interface Answers {
    closes: DayCloses;
    unreadable: Market[];
}

/**
 * Asks each source for the day. On a settled (old) day a page that cannot be read counts as no prices,
 * so one odd page cannot stop the backfill at that day for good; on a recent day it throws, and a later run asks again.
 */
async function readCloses(sources: readonly ClosesSource[], date: string, settled: boolean, closes: DayCloses = {}): Promise<Answers> {
    const answers = await Promise.all(sources.map(async (source) => {
        try {
            return await source.fetchCloses(date);
        } catch (error) {
            if(settled && error instanceof SourceFormatError) return error;
            throw error;
        }
    }));
    const result: Answers = { closes: { ...closes }, unreadable: [] };
    sources.forEach((source, index) => {
        const answer = answers[index];
        if(answer instanceof SourceFormatError) result.unreadable.push(source.market);
        else if(answer) result.closes[source.market] = answer;
    });
    return result;
}

/**
 * Reads one day's closing prices from every market that has data for that day.
 * When only some of them answer with prices, the others are asked once more before the day is judged:
 * a recent day still missing a market comes back as 'retry-later', an older one as 'one-market'.
 */
export async function readClosesOfDay(sources: readonly ClosesSource[], date: string, today: string): Promise<DayReading> {
    const settled = isSettled(date, today);
    const expectedSources = sources.filter((source) => date >= source.firstDate);
    const expected = expectedSources.map((source) => source.market);
    const tradedIn = (closes: DayCloses) => expected.filter((market) => closes[market] !== undefined);

    const first = await readCloses(expectedSources, date, settled);
    const firstVerdict = judgeDay(expected, tradedIn(first.closes), date, today);
    const isClear = firstVerdict === 'trading' || (firstVerdict === 'holiday' && first.unreadable.length === 0);
    if(isClear) return { closes: first.closes, verdict: firstVerdict, unreadable: [] };

    const missing = expectedSources.filter((source) => first.closes[source.market] === undefined);
    const second = await readCloses(missing, date, settled, first.closes);
    return { closes: second.closes, verdict: judgeDay(expected, tradedIn(second.closes), date, today), unreadable: second.unreadable };
}
