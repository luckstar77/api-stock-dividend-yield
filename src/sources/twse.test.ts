import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFormatError } from './format';
import { parseTwseCloses, parseTwseDetail, parseTwseEvents } from './twse';

const TOLERANCE = 1e-9;

function assertClose(actual: number | null | undefined, expected: number) {
    assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < TOLERANCE, `expected ${expected}, got ${actual}`);
}

const CURRENT_EVENT_FIELDS = ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值+息值', '權/息', '漲停價格', '跌停價格', '開盤競價基準', '減除股利參考價', '詳細資料'];
const OLD_EVENT_FIELDS = ['資料日期', '股票代號', '股票名稱', '除權息前收盤價', '除權息參考價', '權值', '息值', '權值+息值', '權/息'];

describe('parseTwseEvents', () => {
    it('takes the cash dividend of a 息 row from the table and leaves 權 rows for the detail page', () => {
        const inputResponse = {
            stat: 'OK',
            fields: CURRENT_EVENT_FIELDS,
            data: [
                ['113年01月04日', '2454', '聯發科', '953.00', '928.40', '24.600000', '息', '1,020.00', '836.00', '928.00', '928.40', '2454,20240104'],
                ['104年01月05日', '2353', '宏碁', '21.35', '21.02', '0.325605', '權', '22.80', '19.55', '21.00', '21.35', '2353,20150105'],
                ['113年01月05日', '9999', '缺價', '--', '10.00', '1.000000', '息', '', '', '', '', ''],
            ],
        };

        const actual = parseTwseEvents(inputResponse);

        assert.deepEqual(actual, [
            { market: 'twse', id: '2454', name: '聯發科', date: '2024-01-04', preExClose: 953, referencePrice: 928.4, kind: 'cash', cashDividend: 24.6, stockDividendPerShare: 0 },
            { market: 'twse', id: '2353', name: '宏碁', date: '2015-01-05', preExClose: 21.35, referencePrice: 21.02, kind: 'stock', cashDividend: null, stockDividendPerShare: null },
        ]);
    });

    it('keeps an estimate from the table\'s cash column for ex-dates that may have no detail page', () => {
        const inputResponse = { stat: 'OK', fields: OLD_EVENT_FIELDS, data: [['94年01月11日', '6280', '崇貿', '33.00', '27.48', 5.52, 0.0, '5.520000', '權']] };

        const [actual] = parseTwseEvents(inputResponse);

        assert.equal(actual.cashDividend, null);
        assert.equal(actual.stockDividendPerShare, null);
        assert.deepEqual(actual.estimatedAmount, { cashDividend: 0, stockDividendPerShare: 0.200873 });
    });

    it('skips a few rows it cannot read, but throws when many cannot be read', () => {
        const goodRow = ['113年01月04日', '2454', '聯發科', '953.00', '928.40', '24.600000', '息', '', '', '', '', ''];
        const oddRow = ['113年01月04日', '2455', '奇怪', '953.00', '928.40', '24.600000', '除息', '', '', '', '', ''];
        const fewOdd = { stat: 'OK', fields: CURRENT_EVENT_FIELDS, data: [...Array(20).fill(goodRow), oddRow] };
        const manyOdd = { stat: 'OK', fields: CURRENT_EVENT_FIELDS, data: [...Array(20).fill(goodRow), ...Array(6).fill(oddRow)] };

        assert.equal(parseTwseEvents(fewOdd).length, 20);
        assert.throws(() => parseTwseEvents(manyOdd), SourceFormatError);
    });

    it('returns nothing for a period without ex-dates and throws on any other answer', () => {
        assert.deepEqual(parseTwseEvents({ stat: '很抱歉，沒有符合條件的資料!' }), []);
        assert.throws(() => parseTwseEvents({ stat: '查詢開始日期小於92年5月5日，請重新查詢!' }), SourceFormatError);
    });
});

describe('parseTwseDetail', () => {
    const DETAIL_FIELDS = ['股票代號', '股票名稱', '(每股配發現金股利)除息', '(增資配股) 除權', 'A. 按普通股股東持股比例每千股無償配股', 'B. 員工紅利轉增資', 'C. (有償) 現金增資'];

    it('reads the cash dividend and the free shares per share', () => {
        const actual = parseTwseDetail({ stat: 'ok', fields: DETAIL_FIELDS, data: [['2375  ', '凱美', '0.5 元／股', '', '26.6 股', '0 股', '0 股']] });

        assertClose(actual?.cashDividend, 0.5);
        assertClose(actual?.stockDividendPerShare, 0.0266);
    });

    it('gives zero amounts for a capital increase paid for in cash', () => {
        const actual = parseTwseDetail({ stat: 'ok', fields: DETAIL_FIELDS, data: [['3058  ', '立德', '0 元／股', '', '0 股', '0 股', '10,000,000 股']] });

        assert.deepEqual(actual, { cashDividend: 0, stockDividendPerShare: 0 });
    });

    it('returns null only when the page says it has no data', () => {
        assert.equal(parseTwseDetail({ stat: '無相關資料' }), null);
    });

    it('throws on any other answer, so an error page is not saved as a zero dividend', () => {
        assert.throws(() => parseTwseDetail({ stat: '查詢過於頻繁，請稍後再試' }), SourceFormatError);
        assert.throws(() => parseTwseDetail({ stat: 'ok', fields: ['股票代號', '股票名稱'], data: [['2454', '聯發科']] }), SourceFormatError);
        assert.throws(() => parseTwseDetail({ stat: 'ok', fields: DETAIL_FIELDS, data: [] }), SourceFormatError);
        assert.throws(() => parseTwseDetail({ stat: 'ok', fields: DETAIL_FIELDS, data: [['2454', '聯發科', '另行公告', '', '0 股', '0 股', '0 股']] }), SourceFormatError);
    });
});

describe('parseTwseCloses', () => {
    const inputTables = [
        { title: '113年01月02日 價格指數(臺灣證券交易所)', fields: ['指數', '收盤指數'], data: [['寶島股價指數', '20,458.03']] },
        {
            title: '113年01月02日 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))',
            fields: ['證券代號', '證券名稱', '成交股數', '收盤價'],
            data: [['2330', '台積電', '20,936,005', '593.00'], ['1101', '台泥', '0', '--']],
        },
    ];

    it('reads the closing price of every security that traded', () => {
        const actual = parseTwseCloses({ stat: 'OK', date: '20240102', tables: inputTables }, '2024-01-02');

        assert.deepEqual(actual, new Map([['2330', { name: '台積電', close: 593 }]]));
    });

    it('returns null on a day without trading', () => {
        assert.equal(parseTwseCloses({ stat: '很抱歉，沒有符合條件的資料!' }, '2024-02-10'), null);
    });

    it('throws when the answer is for another day or has no prices table', () => {
        assert.throws(() => parseTwseCloses({ stat: 'OK', date: '20240103', tables: inputTables }, '2024-01-02'), SourceFormatError);
        assert.throws(() => parseTwseCloses({ stat: 'OK', date: '20240102', tables: [] }, '2024-01-02'), SourceFormatError);
        assert.throws(() => parseTwseCloses({ stat: '查詢日期小於93年2月11日，請重新查詢!' }, '2003-05-05'), SourceFormatError);
    });
});
