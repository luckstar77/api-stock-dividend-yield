import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFormatError } from './format';
import { parseTpexCloses, parseTpexEvents } from './tpex';

const TOLERANCE = 1e-9;

function assertClose(actual: number | null | undefined, expected: number) {
    assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < TOLERANCE, `expected ${expected}, got ${actual}`);
}

const EVENT_FIELDS = ['除權息日期', '代號', '名稱', '除權息前收盤價', '除權息參考價', '權值', '息值', '權值+息值', '權/息', '漲停價', '跌停價', '開始交易基準價', '減除股利參考價', '現金股利', '每仟股無償配股'];

describe('parseTpexEvents', () => {
    it('reads the cash dividend and the free shares from the table', () => {
        const inputResponse = {
            stat: 'ok',
            date: '20240101~20241231',
            tables: [{
                fields: EVENT_FIELDS,
                data: [
                    ['113/01/03', '6629', '泰金-KY           ', '55.00', '53.50', '0.000000', '1.500000', '1.500000', '除息', '58.80', '48.20', '53.50', '53.50', '1.50000000', '0.00000000'],
                    ['113/07/10', '8299', '群聯', '500.00', '470.00', '10.000000', '20.000000', '30.000000', '除權息', '517.00', '423.00', '470.00', '470.00', '20.00000000', '21.27659574'],
                ],
            }],
        };

        const actual = parseTpexEvents(inputResponse, '2024-01-01', '2024-12-31');

        assert.deepEqual(actual[0], { market: 'tpex', id: '6629', name: '泰金-KY', date: '2024-01-03', preExClose: 55, referencePrice: 53.5, kind: 'cash', cashDividend: 1.5, stockDividendPerShare: 0 });
        assert.equal(actual[1].kind, 'both');
        assert.equal(actual[1].cashDividend, 20);
        assertClose(actual[1].stockDividendPerShare, 0.02127659574);
    });

    it('throws when the page answers for another period, as it does for a date it does not accept', () => {
        const inputResponse = { stat: 'ok', date: '20261124~20261125', tables: [{ fields: EVENT_FIELDS, data: [] }] };

        assert.throws(() => parseTpexEvents(inputResponse, '2003-01-01', '2003-12-31'), SourceFormatError);
    });
});

describe('parseTpexCloses', () => {
    const CLOSE_FIELDS = ['代號', '名稱', '收盤 ', '漲跌', '開盤 '];

    it('reads the closing prices, ignoring the spaces in the column names', () => {
        const inputResponse = { stat: 'ok', date: '20240102', tables: [{ fields: CLOSE_FIELDS, data: [['6629', '泰金-KY', '56.10', '+1.10', '55.00'], ['1234', '停牌', '---', '', '']] }] };

        const actual = parseTpexCloses(inputResponse, '2024-01-02');

        assert.deepEqual(actual, new Map([['6629', { name: '泰金-KY', close: 56.1 }]]));
    });

    it('returns null on a day without trading', () => {
        assert.equal(parseTpexCloses({ stat: 'ok', date: '20240210', tables: [{ fields: CLOSE_FIELDS, data: [] }] }, '2024-02-10'), null);
    });

    it('throws when the answer is for another day', () => {
        assert.throws(() => parseTpexCloses({ stat: 'ok', date: '20261123', tables: [{ fields: CLOSE_FIELDS, data: [] }] }, '2003-05-05'), SourceFormatError);
    });
});
