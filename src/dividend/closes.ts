import { StockClose } from '../sources/twse';
import { Market } from './summary';
import { DayVerdict, judgeDay } from './sync-rules';

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
}

async function readCloses(sources: readonly ClosesSource[], date: string, closes: DayCloses = {}): Promise<DayCloses> {
    const answers = await Promise.all(sources.map((source) => source.fetchCloses(date)));
    const result: DayCloses = { ...closes };
    sources.forEach((source, index) => {
        const answer = answers[index];
        if(answer) result[source.market] = answer;
    });
    return result;
}

/**
 * Reads one day's closing prices from every market that has data for that day.
 * When only some of them answer with prices, the others are asked once more before the day is judged:
 * a recent day still missing a market comes back as 'retry-later', an older one as 'one-market'.
 */
export async function readClosesOfDay(sources: readonly ClosesSource[], date: string, today: string): Promise<DayReading> {
    const expectedSources = sources.filter((source) => date >= source.firstDate);
    const expected = expectedSources.map((source) => source.market);
    const tradedIn = (closes: DayCloses) => expected.filter((market) => closes[market] !== undefined);

    const firstAnswer = await readCloses(expectedSources, date);
    const firstVerdict = judgeDay(expected, tradedIn(firstAnswer), date, today);
    if(firstVerdict === 'holiday' || firstVerdict === 'trading') return { closes: firstAnswer, verdict: firstVerdict };

    const missing = expectedSources.filter((source) => firstAnswer[source.market] === undefined);
    const closes = await readCloses(missing, date, firstAnswer);
    return { closes, verdict: judgeDay(expected, tradedIn(closes), date, today) };
}
