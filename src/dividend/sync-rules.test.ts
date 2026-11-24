import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DividendEvent } from './summary';
import { datesToCheck, eventsReadStart, isSettled, judgeDay, rewindCheckpoint, targetDate, toEventUpsert, trackUnreadableDays, UnreadableStreaks } from './sync-rules';

describe('targetDate', () => {
    it('includes today only after the closing prices are published', () => {
        assert.equal(targetDate({ date: '2026-11-24', hour: 18 }), '2026-11-24');
        assert.equal(targetDate({ date: '2026-11-24', hour: 13 }), '2026-11-23');
    });
});

describe('datesToCheck', () => {
    it('starts on the day after the last checked one and leaves out Sundays', () => {
        // 2026-11-22 is a Sunday
        assert.deepEqual(datesToCheck('2026-11-20', '2004-02-11', '2026-11-24'), ['2026-11-21', '2026-11-23', '2026-11-24']);
    });

    it('starts on the first date when nothing was checked yet', () => {
        assert.deepEqual(datesToCheck(undefined, '2026-11-23', '2026-11-24'), ['2026-11-23', '2026-11-24']);
    });

    it('returns nothing when the checks are up to date, e.g. a second run on the same day', () => {
        assert.deepEqual(datesToCheck('2026-11-24', '2004-02-11', '2026-11-24'), []);
    });
});

describe('eventsReadStart', () => {
    it('reads the last 31 days again, but not before the first date', () => {
        assert.equal(eventsReadStart('2026-11-23', '2004-02-11'), '2026-10-23');
        assert.equal(eventsReadStart('2004-02-20', '2004-02-11'), '2004-02-11');
        assert.equal(eventsReadStart(undefined, '2004-02-11'), '2004-02-11');
    });
});

describe('toEventUpsert', () => {
    const inputEvent: DividendEvent = {
        market: 'twse', id: '2353', name: '宏碁', date: '2015-01-05', preExClose: 21.35, referencePrice: 21.02, kind: 'stock', cashDividend: null, stockDividendPerShare: null,
    };

    it('leaves the amounts read from the detail page alone when the table does not give them', () => {
        const actual = toEventUpsert(inputEvent);

        assert.deepEqual(actual, {
            updateOne: {
                filter: { market: 'twse', id: '2353', date: '2015-01-05' },
                update: {
                    $set: { name: '宏碁', preExClose: 21.35, referencePrice: 21.02, kind: 'stock' },
                    $setOnInsert: { filledDate: null, cashDividend: null, stockDividendPerShare: null },
                },
                upsert: true,
            },
        });
    });

    it('saves the amounts the table gives, and never touches filledDate after the first save', () => {
        const actual = toEventUpsert({ ...inputEvent, kind: 'cash', cashDividend: 0.5, stockDividendPerShare: 0 });

        assert.ok('updateOne' in actual);
        const { update } = actual.updateOne;
        assert.deepEqual(update, {
            $set: { name: '宏碁', preExClose: 21.35, referencePrice: 21.02, kind: 'cash', cashDividend: 0.5, stockDividendPerShare: 0 },
            $setOnInsert: { filledDate: null },
        });
    });

    it('flags an event first saved after its ex-date was checked, in the same write', () => {
        const late = toEventUpsert(inputEvent, '2015-01-20');
        const onTime = toEventUpsert(inputEvent, '2015-01-02');
        const unchecked = toEventUpsert(inputEvent);

        assert.ok('updateOne' in late && 'updateOne' in onTime && 'updateOne' in unchecked);
        assert.deepEqual(late.updateOne.update, {
            $set: { name: '宏碁', preExClose: 21.35, referencePrice: 21.02, kind: 'stock' },
            $setOnInsert: { filledDate: null, cashDividend: null, stockDividendPerShare: null, needsRecheck: true },
        });
        assert.deepEqual(onTime.updateOne.update, unchecked.updateOne.update);
    });
});

describe('judgeDay', () => {
    it('tells a holiday from a trading day', () => {
        assert.equal(judgeDay(['twse', 'tpex'], [], '2024-02-10', '2026-11-24'), 'holiday');
        assert.equal(judgeDay(['twse', 'tpex'], ['twse', 'tpex'], '2024-02-15', '2026-11-24'), 'trading');
        assert.equal(judgeDay(['twse'], ['twse'], '2005-03-01', '2026-11-24'), 'trading');
    });

    it('waits for a recent day on which one market has no prices yet, and accepts an old gap', () => {
        assert.equal(judgeDay(['twse', 'tpex'], ['twse'], '2026-11-23', '2026-11-24'), 'retry-later');
        assert.equal(judgeDay(['twse', 'tpex'], ['tpex'], '2015-06-01', '2026-11-24'), 'one-market');
    });
});

describe('isSettled', () => {
    it('treats days more than 7 days back as settled', () => {
        assert.equal(isSettled('2026-11-17', '2026-11-24'), false);
        assert.equal(isSettled('2026-11-16', '2026-11-24'), true);
    });
});

describe('trackUnreadableDays', () => {
    const MARKETS = ['twse', 'tpex'] as const;

    it('lets a single unreadable day pass and resets the streak on a readable day', () => {
        const first = trackUnreadableDays({}, MARKETS, ['tpex'], '2015-06-01');
        const second = trackUnreadableDays(first.streaks, MARKETS, [], '2015-06-02');

        assert.deepEqual(first.tooLong, []);
        assert.deepEqual(first.streaks, { twse: [], tpex: ['2015-06-01'] });
        assert.deepEqual(second.streaks, { twse: [], tpex: [] });
    });

    it('reports a market once it could not be read on 3 days in a row', () => {
        let streaks: UnreadableStreaks = {};
        const tooLong: string[][] = [];
        for(const date of ['2015-06-01', '2015-06-02', '2015-06-03']) {
            const result = trackUnreadableDays(streaks, MARKETS, ['twse'], date);
            streaks = result.streaks;
            tooLong.push(result.tooLong);
        }

        assert.deepEqual(tooLong, [[], [], ['twse']]);
        assert.deepEqual(streaks.twse, ['2015-06-01', '2015-06-02', '2015-06-03']);
    });
});

describe('rewindCheckpoint', () => {
    it('goes back to the day before an ex-date that appeared after its day was checked', () => {
        assert.equal(rewindCheckpoint('2026-11-23', ['2026-11-25', '2026-11-10', '2026-11-12']), '2026-11-09');
    });

    it('stays when the new ex-dates are all after the checked days, or nothing was checked yet', () => {
        assert.equal(rewindCheckpoint('2026-11-23', ['2026-11-24']), '2026-11-23');
        assert.equal(rewindCheckpoint(undefined, ['2004-03-01']), undefined);
        assert.equal(rewindCheckpoint('2026-11-23', []), '2026-11-23');
    });
});
