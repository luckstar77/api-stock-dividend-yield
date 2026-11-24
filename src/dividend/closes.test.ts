import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFormatError } from '../sources/format';
import { StockClose } from '../sources/twse';
import { ClosesSource, readClosesOfDay } from './closes';
import { Market } from './summary';

type Answer = Map<string, StockClose> | null | SourceFormatError;

const TODAY = '2026-11-24';
const PRICES: Map<string, StockClose> = new Map([['2330', { name: '台積電', close: 1000 }]]);

/** A market that gives the listed answers in turn, and counts how often it was asked. */
function createSource(market: Market, firstDate: string, answers: Answer[]): ClosesSource & { calls: number } {
    const source = {
        market,
        firstDate,
        calls: 0,
        fetchCloses: async () => {
            const answer = answers[Math.min(source.calls, answers.length - 1)];
            source.calls++;
            if(answer instanceof SourceFormatError) throw answer;
            return answer;
        },
    };
    return source;
}

describe('readClosesOfDay', () => {
    it('reads both markets once on a normal trading day', async () => {
        const mockTwse = createSource('twse', '2004-02-11', [PRICES]);
        const mockTpex = createSource('tpex', '2007-07-02', [PRICES]);

        const actual = await readClosesOfDay([mockTwse, mockTpex], '2026-11-23', TODAY);

        assert.equal(actual.verdict, 'trading');
        assert.deepEqual([mockTwse.calls, mockTpex.calls], [1, 1]);
    });

    it('does not ask again on a holiday', async () => {
        const mockTwse = createSource('twse', '2004-02-11', [null]);
        const mockTpex = createSource('tpex', '2007-07-02', [null]);

        const actual = await readClosesOfDay([mockTwse, mockTpex], '2026-11-21', TODAY);

        assert.equal(actual.verdict, 'holiday');
        assert.deepEqual([mockTwse.calls, mockTpex.calls], [1, 1]);
    });

    it('asks only the missing market once more, and is satisfied when it then answers', async () => {
        const mockTwse = createSource('twse', '2004-02-11', [PRICES]);
        const mockTpex = createSource('tpex', '2007-07-02', [null, PRICES]);

        const actual = await readClosesOfDay([mockTwse, mockTpex], '2026-11-23', TODAY);

        assert.equal(actual.verdict, 'trading');
        assert.ok(actual.closes.twse && actual.closes.tpex);
        assert.deepEqual([mockTwse.calls, mockTpex.calls], [1, 2]);
    });

    it('waits for a recent day that still misses a market, and accepts an old one', async () => {
        const recent = await readClosesOfDay([createSource('twse', '2004-02-11', [PRICES]), createSource('tpex', '2007-07-02', [null])], '2026-11-23', TODAY);
        const old = await readClosesOfDay([createSource('twse', '2004-02-11', [PRICES]), createSource('tpex', '2007-07-02', [null])], '2015-06-01', TODAY);

        assert.equal(recent.verdict, 'retry-later');
        assert.equal(old.verdict, 'one-market');
        assert.ok(old.closes.twse);
    });

    it('counts an unreadable page of an old day as no prices, after asking once more', async () => {
        const mockTpex = createSource('tpex', '2007-07-02', [new SourceFormatError('odd page')]);

        const actual = await readClosesOfDay([createSource('twse', '2004-02-11', [PRICES]), mockTpex], '2015-06-01', TODAY);

        assert.equal(actual.verdict, 'one-market');
        assert.deepEqual(actual.unreadable, ['tpex']);
        assert.equal(mockTpex.calls, 2);
    });

    it('is satisfied when the page of an old day reads fine the second time', async () => {
        const mockTwse = createSource('twse', '2004-02-11', [new SourceFormatError('odd page'), PRICES]);

        const actual = await readClosesOfDay([mockTwse, createSource('tpex', '2007-07-02', [PRICES])], '2015-06-01', TODAY);

        assert.equal(actual.verdict, 'trading');
        assert.deepEqual(actual.unreadable, []);
    });

    it('throws on an unreadable page of a recent day, so a later run asks again', async () => {
        const sources = [createSource('twse', '2004-02-11', [new SourceFormatError('odd page')]), createSource('tpex', '2007-07-02', [PRICES])];

        await assert.rejects(readClosesOfDay(sources, '2026-11-23', TODAY), SourceFormatError);
    });

    it('does not ask a market for a day before its data starts', async () => {
        const mockTwse = createSource('twse', '2004-02-11', [PRICES]);
        const mockTpex = createSource('tpex', '2007-07-02', [PRICES]);

        const actual = await readClosesOfDay([mockTwse, mockTpex], '2005-03-01', TODAY);

        assert.equal(actual.verdict, 'trading');
        assert.equal(mockTpex.calls, 0);
    });
});
