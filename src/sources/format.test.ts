import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, assertFewSkipped, isSunday, makeRowReader, parseAmount, parseNumber, parseRocDate, SourceFormatError, taipeiNow, toRocSlashDate, yearRanges } from './format';

describe('dates', () => {
    it('reads both ROC date formats', () => {
        assert.equal(parseRocDate('113年01月04日'), '2024-01-04');
        assert.equal(parseRocDate('96/12/17'), '2007-12-17');
        assert.equal(parseRocDate('not a date'), undefined);
    });

    it('writes three-digit ROC years for the TPEx pages', () => {
        assert.equal(toRocSlashDate('2007-07-02'), '096/07/02');
        assert.equal(toRocSlashDate('2024-01-04'), '113/01/04');
    });

    it('adds days across months and years', () => {
        assert.equal(addDays('2024-02-28', 2), '2024-03-01');
        assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    });

    it('knows Sundays', () => {
        assert.equal(isSunday('2026-11-22'), true);
        assert.equal(isSunday('2026-11-21'), false);
    });

    it('gives the Taiwan date and hour', () => {
        const actual = taipeiNow(new Date('2026-11-24T16:30:00Z'));
        assert.deepEqual(actual, { date: '2026-11-25', hour: 0 });
    });

    it('splits a period into calendar years', () => {
        const actual = yearRanges('2023-11-01', '2025-02-03');
        assert.deepEqual(actual, [
            { start: '2023-11-01', end: '2023-12-31' },
            { start: '2024-01-01', end: '2024-12-31' },
            { start: '2025-01-01', end: '2025-02-03' },
        ]);
        assert.deepEqual(yearRanges('2025-02-04', '2025-02-03'), []);
    });
});

describe('numbers', () => {
    it('reads prices with thousands separators and rejects placeholders', () => {
        assert.equal(parseNumber('1,020.00'), 1020);
        assert.equal(parseNumber(5.52), 5.52);
        assert.equal(parseNumber('--'), undefined);
        assert.equal(parseNumber(''), undefined);
    });

    it('reads amounts followed by a unit', () => {
        assert.equal(parseAmount('24.6 元／股'), 24.6);
        assert.equal(parseAmount('10,000,000 股'), 10000000);
        assert.equal(parseAmount(''), 0);
        assert.equal(parseAmount('無'), undefined);
    });
});

describe('assertFewSkipped', () => {
    it('allows up to 5 skipped rows in a table and throws on more', () => {
        assert.doesNotThrow(() => assertFewSkipped(5, 1500, 'page'));
        assert.throws(() => assertFewSkipped(6, 1500, 'page'), SourceFormatError);
    });
});

describe('makeRowReader', () => {
    it('reads cells by column name, ignoring spaces around the names', () => {
        const read = makeRowReader(['代號', '收盤 '], ['代號', '收盤']);
        assert.equal(read(['2330', '968.00'], '收盤'), '968.00');
    });

    it('throws when a needed column is missing', () => {
        assert.throws(() => makeRowReader(['代號'], ['代號', '收盤']), SourceFormatError);
    });
});
