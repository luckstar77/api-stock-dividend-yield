import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findFilledEvents, summarizeDividends, TrackedDividendEvent } from './summary';

const TOLERANCE = 1e-9;

function assertClose(actual: number | null | undefined, expected: number) {
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

describe('summarizeDividends', () => {
    it('counts a year as filled only when every ex-date in it was filled', () => {
        const inputEvents = [
            createEvent({ date: '2023-03-16' }),
            createEvent({ date: '2023-09-14' }),
            createEvent({ date: '2024-03-14' }),
            createEvent({ date: '2024-09-12', filledDate: null }),
        ];

        const actual = summarizeDividends(inputEvents);

        assert.equal(actual?.amountOfDividend, 2);
        assert.equal(actual?.amountOfSuccess, 1);
        assert.equal(actual?.successRate, 50);
        assert.equal(actual?.dividendYearStart, 2023);
        assert.equal(actual?.dividendYearEnd, 2024);
    });

    it('adds up the yields within a year and averages them over the years', () => {
        const inputEvents = [
            createEvent({ date: '2023-03-16', cashDividend: 2, preExClose: 100 }),
            createEvent({ date: '2023-09-14', cashDividend: 3, preExClose: 100 }),
            createEvent({ date: '2024-07-01', kind: 'both', cashDividend: 1, stockDividendPerShare: 0.1, preExClose: 50, referencePrice: 40 }),
        ];

        const actual = summarizeDividends(inputEvents);

        // 2023: 2% + 3% = 5%; 2024: 1 ÷ 50 = 2% cash, (1 + 0.1 × 40) ÷ 50 = 10% with the shares
        assertClose(actual?.allAvgCashYields, 3.5);
        assertClose(actual?.allAvgRetroactiveYields, 7.5);
    });

    it('leaves out a capital increase paid for in cash', () => {
        const inputEvents = [
            createEvent({ date: '2023-03-16' }),
            createEvent({ date: '2024-01-05', kind: 'stock', cashDividend: 0, stockDividendPerShare: 0, filledDate: null }),
        ];

        const actual = summarizeDividends(inputEvents);

        assert.equal(actual?.amountOfDividend, 1);
        assert.equal(actual?.successRate, 100);
    });

    it('returns undefined while an amount is unknown or when there was never a dividend', () => {
        assert.equal(summarizeDividends([createEvent({ kind: 'stock', cashDividend: null, stockDividendPerShare: null })]), undefined);
        assert.equal(summarizeDividends([createEvent({ kind: 'stock', cashDividend: 0, stockDividendPerShare: 0 })]), undefined);
        assert.equal(summarizeDividends([]), undefined);
    });
});

describe('findFilledEvents', () => {
    const inputEvents = [
        createEvent({ id: '2330', date: '2024-06-13', preExClose: 100, filledDate: null }),
        createEvent({ id: '2454', date: '2024-06-13', preExClose: 50, filledDate: null }),
        createEvent({ id: '1101', date: '2024-06-20', preExClose: 30, filledDate: null }),
        createEvent({ id: '2603', date: '2024-06-13', preExClose: 40, filledDate: null }),
    ];

    it('fills an ex-date when the stock closes at the pre-ex close or above, from the ex-date on', () => {
        const inputCloses = new Map([['2330', 100], ['2454', 49.95], ['1101', 31]]);

        const actual = findFilledEvents(inputEvents, '2024-06-14', inputCloses);

        assert.deepEqual(actual.map((event) => event.id), ['2330']);
    });
});
