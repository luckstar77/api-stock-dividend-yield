/**
 * Helpers for the formats used by the TWSE and TPEx pages.
 * Dates are passed around as 'YYYY-MM-DD' strings in Taiwan time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ROC_YEAR_OFFSET = 1911;
const ROC_YEAR_DIGITS = 3;
const ROC_DATE_PATTERN = /^(\d{2,3})\D(\d{1,2})\D(\d{1,2})/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const LEADING_NUMBER_PATTERN = /^-?\d+(\.\d+)?/;

/** The page answered, but not in the format this code expects. */
export class SourceFormatError extends Error {}

export interface DateRange {
    start: string;
    end: string;
}

function toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
    return toIsoDate(new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS));
}

export function isSunday(isoDate: string): boolean {
    return new Date(`${isoDate}T00:00:00Z`).getUTCDay() === 0;
}

export function laterOf(first: string, second: string | undefined): string {
    return second !== undefined && second > first ? second : first;
}

/** Today's date and the current hour in Taiwan, whatever the time zone of the host. */
export function taipeiNow(now: Date = new Date()): { date: string; hour: number } {
    const shifted = new Date(now.getTime() + TAIPEI_OFFSET_MS);
    return { date: toIsoDate(shifted), hour: shifted.getUTCHours() };
}

/** '2024-01-04' → '20240104' */
export function toCompactDate(isoDate: string): string {
    return isoDate.replace(/-/g, '');
}

/** '113年01月04日' (TWSE) or '113/01/04' (TPEx) → '2024-01-04' */
export function parseRocDate(text: string): string | undefined {
    const match = text.trim().match(ROC_DATE_PATTERN);
    if(!match) return undefined;
    const [, year, month, day] = match;
    return `${Number(year) + ROC_YEAR_OFFSET}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** '2007-07-02' → '096/07/02'. The TPEx pages ignore a two-digit year and answer with the latest day instead. */
export function toRocSlashDate(isoDate: string): string {
    const [year, month, day] = isoDate.split('-');
    return `${String(Number(year) - ROC_YEAR_OFFSET).padStart(ROC_YEAR_DIGITS, '0')}/${month}/${day}`;
}

/** Splits a period into calendar years, because the ex-dividend pages answer at most one year at a time. */
export function yearRanges(start: string, end: string): DateRange[] {
    const ranges: DateRange[] = [];
    for(let rangeStart = start; rangeStart <= end; rangeStart = `${Number(rangeStart.slice(0, 4)) + 1}-01-01`) {
        const yearEnd = `${rangeStart.slice(0, 4)}-12-31`;
        ranges.push({ start: rangeStart, end: yearEnd < end ? yearEnd : end });
    }
    return ranges;
}

/** '1,020.00' → 1020. Returns undefined for '--', '' and anything else that is not a plain number. */
export function parseNumber(value: unknown): number | undefined {
    if(typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if(typeof value !== 'string') return undefined;
    const text = value.replace(/,/g, '').trim();
    return NUMBER_PATTERN.test(text) ? Number(text) : undefined;
}

/** '24.6 元／股' → 24.6, '' → 0 */
export function parseAmount(value: unknown): number | undefined {
    const text = String(value ?? '').replace(/,/g, '').trim();
    if(text === '') return 0;
    const match = text.match(LEADING_NUMBER_PATTERN);
    return match ? Number(match[0]) : undefined;
}

/**
 * A few odd rows are skipped with a warning. In the tables of 2004–2026 at most one row a year could not be read
 * and no kind was unknown, so more than this in one table means the page format has changed.
 */
const MAX_SKIPPED_ROWS = 5;

/** Throws when so many rows were skipped that the page format has probably changed. */
export function assertFewSkipped(skipped: number, total: number, page: string): void {
    if(skipped > MAX_SKIPPED_ROWS) throw new SourceFormatError(`${page}: ${skipped} of ${total} rows could not be read`);
}

export function hasColumn(fields: unknown, name: string): boolean {
    return Array.isArray(fields) && fields.some((field) => String(field).trim() === name);
}

/**
 * Reads cells by column name, so a column added or moved on the page does not shift the values.
 * Throws when a column this code needs is missing.
 */
export function makeRowReader(fields: unknown, required: readonly string[]): (row: unknown[], name: string) => unknown {
    const names = Array.isArray(fields) ? fields.map((field) => String(field).trim()) : [];
    const missing = required.filter((name) => !names.includes(name));
    if(missing.length > 0) throw new SourceFormatError(`missing columns: ${missing.join(', ')}`);
    return (row, name) => row[names.indexOf(name)];
}
