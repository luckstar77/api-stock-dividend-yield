import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { createApp } from './app';
import { TrackedDividendEvent } from './dividend/summary';
import { StockDocument, StockRepository } from './repositories/stock-repository';
import { StockListRepository } from './repositories/stock-list-repository';
import { StockService } from './services/stock-service';

const FIXED_NOW = new Date('2026-11-26T04:00:00Z');
const HEALTH_TIMEOUT_MS = 50;

class FakeStockRepository implements StockRepository {
    stocks: StockDocument[] = [];
    events: TrackedDividendEvent[] = [];
    failure?: Error;
    isHanging = false;

    async findStockByKeyword(keyword: string): Promise<StockDocument | null> {
        if(this.failure) throw this.failure;
        return this.stocks.find((stock) => stock.id === keyword || stock.name === keyword) ?? null;
    }

    async findDividendEvents(id: string): Promise<TrackedDividendEvent[]> {
        return this.events.filter((event) => event.id === id).sort((first, second) => first.date.localeCompare(second.date));
    }

    async ping(): Promise<void> {
        if(this.failure) throw this.failure;
        if(this.isHanging) await new Promise(() => undefined);
    }
}

class FakeStockListRepository implements StockListRepository {
    entries: string[] = [];
    listDate: string | null = null;
    failure?: Error;

    async findEntries(): Promise<string[]> {
        if(this.failure) throw this.failure;
        return this.entries;
    }

    async findListDate(): Promise<string | null> {
        return this.listDate;
    }

    async ping(): Promise<void> {
        if(this.failure) throw this.failure;
    }
}

function createStock(overrides: StockDocument = {}): StockDocument {
    return {
        _id: '6350b4323bd59db98a2345cc',
        id: '2330',
        name: '台積電',
        updated: new Date('2026-11-25T10:35:38.711Z'),
        allAvgCashYields: 3.1555969257801637,
        allAvgRetroactiveYields: 4.099856276335496,
        amountOfDividend: 23,
        amountOfSuccess: 23,
        dividendYearEnd: 2026,
        dividendYearStart: 2004,
        successRate: 100,
        dataThrough: '2026-11-25',
        source: 'twse-tpex',
        ...overrides,
    };
}

function createEvent(overrides: Partial<TrackedDividendEvent>): TrackedDividendEvent {
    return {
        market: 'twse',
        id: '2330',
        name: '台積電',
        date: '2026-06-12',
        preExClose: 1000,
        referencePrice: 995,
        kind: 'cash',
        cashDividend: 5,
        stockDividendPerShare: 0,
        filledDate: '2026-06-15',
        ...overrides,
    };
}

describe('app', () => {
    let server: Server;
    let baseUrl: string;
    let stockRepository: FakeStockRepository;
    let stockListRepository: FakeStockListRepository;

    before(async () => {
        stockRepository = new FakeStockRepository();
        stockListRepository = new FakeStockListRepository();
        const stockService = new StockService(stockRepository, stockListRepository, { now: () => FIXED_NOW, healthTimeoutMs: HEALTH_TIMEOUT_MS });
        server = createApp({ stockService }).listen(0);
        await new Promise<void>((resolve) => server.once('listening', () => resolve()));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    beforeEach(() => {
        stockRepository.stocks = [];
        stockRepository.events = [];
        stockRepository.failure = undefined;
        stockRepository.isHanging = false;
        stockListRepository.entries = [];
        stockListRepository.listDate = null;
        stockListRepository.failure = undefined;
    });

    it('does not tell which framework it runs on', async () => {
        const response = await fetch(`${baseUrl}/v1/health`);

        assert.equal(response.headers.get('x-powered-by'), null);
    });

    describe('GET /v1/health', () => {
        it('answers up when MongoDB and Redis answer', async () => {
            const response = await fetch(`${baseUrl}/v1/health`);

            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.deepEqual(await response.json(), { status: 'ok', code: 20000, data: { mongodb: 'up', redis: 'up' } });
        });

        it('answers 500 when a database does not answer', async () => {
            stockListRepository.failure = new Error('Redis down');

            const response = await fetch(`${baseUrl}/v1/health`);

            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), { status: 'error', code: 50000, error: { message: 'Internal server error' } });
        });

        it('answers 500 instead of waiting when a database holds the connection without answering', async () => {
            stockRepository.isHanging = true;

            const response = await fetch(`${baseUrl}/v1/health`);

            assert.equal(response.status, 500);
        });
    });

    describe('GET /v1/stocks', () => {
        it('answers the entries split at the first space and sorted by id', async () => {
            stockListRepository.entries = ['2330 台積電', '0050 元大台灣50', '9999 Some Name With Spaces'];
            stockListRepository.listDate = '2026-11-25';

            const response = await fetch(`${baseUrl}/v1/stocks`);

            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'public, max-age=600');
            assert.deepEqual(await response.json(), {
                status: 'ok',
                code: 20000,
                data: {
                    list: [
                        { idString: '0050', name: '元大台灣50' },
                        { idString: '2330', name: '台積電' },
                        { idString: '9999', name: 'Some Name With Spaces' },
                    ],
                    listDate: '2026-11-25',
                },
            });
        });

        it('answers 20400 with an empty list before the first sync', async () => {
            const response = await fetch(`${baseUrl}/v1/stocks`);

            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.deepEqual(await response.json(), { status: 'ok', code: 20400, data: { list: [], listDate: null } });
        });

        it('answers 500 when Redis fails', async () => {
            stockListRepository.failure = new Error('Redis down');

            const response = await fetch(`${baseUrl}/v1/stocks`);

            assert.equal(response.status, 500);
        });
    });

    describe('GET /v1/stocks/dividends', () => {
        it('answers 40000 without a keyword', async () => {
            for(const query of ['', '?keyword=', '?keyword=%20%20']) {
                const response = await fetch(`${baseUrl}/v1/stocks/dividends${query}`);
                const body = await response.json();

                assert.equal(response.status, 200);
                assert.equal(body.code, 40000);
                assert.equal(body.status, 'error');
                assert.equal(typeof body.error.message, 'string');
            }
        });

        it('answers 20400 for an unknown stock or one without a summary', async () => {
            stockRepository.stocks = [createStock({ id: '9999', name: '無統計', successRate: undefined })];

            for(const keyword of ['1234', '9999']) {
                const response = await fetch(`${baseUrl}/v1/stocks/dividends?keyword=${keyword}`);

                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.deepEqual(await response.json(), { status: 'ok', code: 20400 });
            }
        });

        it('answers the summary, the trailing yield and the history, found by trimmed id or name', async () => {
            stockRepository.stocks = [createStock({ lastClose: 1450, lastCloseDate: '2026-11-25' })];
            stockRepository.events = [
                createEvent({ date: '2025-12-11', cashDividend: 5, filledDate: '2025-12-11' }),
                createEvent({ date: '2026-03-17', cashDividend: 5, filledDate: '2026-03-20' }),
                createEvent({ date: '2026-06-11', cashDividend: 5, filledDate: null }),
                createEvent({ date: '2024-12-12', cashDividend: 4.5, filledDate: '2024-12-13' }),
            ];

            for(const keyword of ['%202330%20', encodeURIComponent('台積電')]) {
                const response = await fetch(`${baseUrl}/v1/stocks/dividends?keyword=${keyword}`);
                const body = await response.json();

                assert.equal(response.headers.get('cache-control'), 'public, max-age=600');
                assert.equal(body.code, 20000);
                assert.equal(body.data.idString, '2330');
                assert.equal(body.data.market, 'twse');
                assert.equal(body.data.successRatio, 100);
                assert.equal(body.data.dividendYearCount, 23);
                assert.equal(body.data.dividendYearStart, 2004);
                assert.equal(body.data.dataThroughDate, '2026-11-25');
                assert.equal(body.data.updatedAt, '2026-11-25T10:35:38.711Z');
                assert.equal(body.data.lastClose, 1450);
                assert.equal(body.data.trailingCashDividend, 15);
                assert.ok(Math.abs(body.data.trailingCashYieldRatio - (15 / 1450) * 100) < 1e-9);
                assert.deepEqual(body.data.years.map((year: { year: number }) => year.year), [2026, 2025, 2024]);
                assert.equal(body.data.years[0].isFilled, false);
                assert.deepEqual(body.data.years[0].events.map((event: { fillDayCount: number | null }) => event.fillDayCount), [3, null]);
            }
        });

        it('answers nulls for what old documents do not have and reads their years kept as text', async () => {
            stockRepository.stocks = [createStock({ dividendYearStart: '1991', dividendYearEnd: '2022', dataThrough: undefined, updated: undefined })];

            const body = await (await fetch(`${baseUrl}/v1/stocks/dividends?keyword=2330`)).json();

            assert.equal(body.data.dividendYearStart, 1991);
            assert.equal(body.data.dividendYearEnd, 2022);
            assert.equal(body.data.market, null);
            assert.equal(body.data.dataThroughDate, null);
            assert.equal(body.data.updatedAt, null);
            assert.equal(body.data.lastClose, null);
            assert.equal(body.data.lastCloseDate, null);
            assert.equal(body.data.trailingCashYieldRatio, null);
            assert.deepEqual(body.data.years, []);
        });

        it('answers 500 when MongoDB fails', async () => {
            stockRepository.failure = new Error('MongoDB down');

            const response = await fetch(`${baseUrl}/v1/stocks/dividends?keyword=2330`);

            assert.equal(response.status, 500);
            assert.equal((await response.json()).code, 50000);
        });
    });

    it('answers a JSON 404 for an unknown /v1 path', async () => {
        const response = await fetch(`${baseUrl}/v1/nothing`);

        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { status: 'error', code: 40400, error: { message: 'Not found' } });
    });

    describe('legacy GET /stock', () => {
        it('answers 404 without a search or for a stock without a summary', async () => {
            stockRepository.stocks = [createStock({ id: '9999', successRate: undefined })];

            for(const query of ['', '?search=', '?search=9999', '?search=1234']) {
                const response = await fetch(`${baseUrl}/stock${query}`);

                assert.equal(response.status, 404);
            }
        });

        it('answers the stored document as it is', async () => {
            const stock = createStock();
            stockRepository.stocks = [stock];

            const response = await fetch(`${baseUrl}/stock?search=2330`);

            assert.equal(response.status, 200);
            assert.equal(await response.text(), JSON.stringify(stock));
        });

        it('answers 500 when MongoDB fails', async () => {
            stockRepository.failure = new Error('MongoDB down');

            assert.equal((await fetch(`${baseUrl}/stock?search=2330`)).status, 500);
        });
    });

    describe('legacy GET /stocks', () => {
        it('answers the raw entries', async () => {
            stockListRepository.entries = ['2330 台積電', '0050 元大台灣50'];

            const response = await fetch(`${baseUrl}/stocks`);

            assert.deepEqual(await response.json(), ['2330 台積電', '0050 元大台灣50']);
        });

        it('answers 503 before the first sync and 500 when Redis fails', async () => {
            assert.equal((await fetch(`${baseUrl}/stocks`)).status, 503);

            stockListRepository.failure = new Error('Redis down');

            assert.equal((await fetch(`${baseUrl}/stocks`)).status, 500);
        });
    });
});
