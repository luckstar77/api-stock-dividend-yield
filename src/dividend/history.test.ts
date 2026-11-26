import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDividendYears, trailingCashDividend } from './history';
import { TrackedDividendEvent } from './summary';

const TOLERANCE = 1e-9;

function assertClose(actual: number | undefined, expected: number) {
    assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < TOLERANCE, `expected ${expected}, got ${actual}`);
}

function createEvent(overrides: Partial<TrackedDividendEvent>): TrackedDividendEvent {
    return {
        market: 'twse',
        id: '2330',
        name: '台積電',
        date: '2024-06-13',
        preExClose: 100,
        referencePrice: 96,
        kind: 'cash',
        cashDividend: 4,
        stockDividendPerShare: 0,
        filledDate: '2024-06-14',
        ...overrides,
    };
}

describe('buildDividendYears', () => {
    it('groups the ex-dates by year, newest year first and each year oldest ex-date first', () => {
        const inputEvents = [
            createEvent({ date: '2023-09-14' }),
            createEvent({ date: '2024-09-12' }),
            createEvent({ date: '2023-03-16' }),
            createEvent({ date: '2024-03-14' }),
        ];

        const actual = buildDividendYears(inputEvents);

        assert.deepEqual(actual.map((year) => year.year), [2024, 2023]);
        assert.deepEqual(actual[0].events.map((event) => event.exDate), ['2024-03-14', '2024-09-12']);
        assert.deepEqual(actual[1].events.map((event) => event.exDate), ['2023-03-16', '2023-09-14']);
    });

    it('sums the year\'s dividends and quotes the stock dividend in NT$ of NT$10 face value', () => {
        const inputEvents = [
            createEvent({ date: '2024-03-14', cashDividend: 3, stockDividendPerShare: 0 }),
            createEvent({ date: '2024-09-12', kind: 'both', cashDividend: 1.5, stockDividendPerShare: 0.05 }),
        ];

        const [actual] = buildDividendYears(inputEvents);

        assertClose(actual.cashDividend, 4.5);
        assertClose(actual.stockDividend, 0.5);
        assertClose(actual.events[1].stockDividend, 0.5);
    });

    it('works out the yields with the same formulas as the summary', () => {
        const inputEvents = [
            createEvent({ date: '2024-03-14', preExClose: 100, referencePrice: 96, cashDividend: 4, stockDividendPerShare: 0 }),
            createEvent({ date: '2024-09-12', kind: 'both', preExClose: 50, referencePrice: 45, cashDividend: 1, stockDividendPerShare: 0.1 }),
        ];

        const [actual] = buildDividendYears(inputEvents);

        // cash: 4/100 + 1/50; retroactive: 4/100 + (1 + 0.1 × 45)/50
        assertClose(actual.cashYieldRatio, (4 / 100 + 1 / 50) * 100);
        assertClose(actual.retroactiveYieldRatio, (4 / 100 + (1 + 0.1 * 45) / 50) * 100);
    });

    it('marks a year as filled only when every ex-date in it was filled', () => {
        const inputEvents = [
            createEvent({ date: '2023-03-16' }),
            createEvent({ date: '2024-03-14' }),
            createEvent({ date: '2024-09-12', filledDate: null }),
        ];

        const actual = buildDividendYears(inputEvents);

        assert.equal(actual.find((year) => year.year === 2024)?.isFilled, false);
        assert.equal(actual.find((year) => year.year === 2023)?.isFilled, true);
    });

    it('counts the calendar days to the fill: 0 on the ex-date, null while not filled', () => {
        const inputEvents = [
            createEvent({ date: '2024-03-14', filledDate: '2024-03-14' }),
            createEvent({ date: '2024-06-13', filledDate: '2024-07-15' }),
            createEvent({ date: '2024-09-12', filledDate: null }),
        ];

        const [actual] = buildDividendYears(inputEvents);

        assert.deepEqual(actual.events.map((event) => event.fillDayCount), [0, 32, null]);
    });

    it('leaves out capital increases and ex-dates whose amounts are not known', () => {
        const inputEvents = [
            createEvent({ date: '2024-03-14' }),
            createEvent({ date: '2024-06-13', kind: 'stock', cashDividend: 0, stockDividendPerShare: 0 }),
            createEvent({ date: '2024-09-12', cashDividend: null, stockDividendPerShare: null }),
        ];

        const [actual] = buildDividendYears(inputEvents);

        assert.deepEqual(actual.events.map((event) => event.exDate), ['2024-03-14']);
    });

    it('flags the amounts worked out from the table', () => {
        const inputEvents = [createEvent({ date: '2005-07-01', amountEstimated: true }), createEvent({ date: '2006-07-01' })];

        const actual = buildDividendYears(inputEvents);

        assert.deepEqual(actual.map((year) => year.events[0].isAmountEstimated), [false, true]);
    });

    it('answers an empty history when nothing counts', () => {
        assert.deepEqual(buildDividendYears([]), []);
    });
});

describe('trailingCashDividend', () => {
    it('sums the cash dividends of the 365 days up to and including the date', () => {
        const inputEvents = [
            createEvent({ date: '2025-11-25', cashDividend: 1 }),
            createEvent({ date: '2025-11-26', cashDividend: 2 }),
            createEvent({ date: '2026-11-25', cashDividend: 3 }),
            createEvent({ date: '2026-11-26', cashDividend: 4 }),
        ];

        const actual = trailingCashDividend(inputEvents, '2026-11-25');

        assertClose(actual, 5);
    });

    it('leaves out ex-dates whose amounts are not known', () => {
        const inputEvents = [createEvent({ date: '2026-06-01', cashDividend: null }), createEvent({ date: '2026-07-01', cashDividend: 2 })];

        assertClose(trailingCashDividend(inputEvents, '2026-11-25'), 2);
    });

    it('is 0 without an ex-date in the period', () => {
        assert.equal(trailingCashDividend([createEvent({ date: '2020-01-01' })], '2026-11-25'), 0);
    });
});
