import express from 'express';
import { existsSync } from 'fs';
import { connect as mongodbConnect } from './db/mongodb';
import { connect as redisConnect } from './db/redis';
import cors from 'cors';
import dayjs from 'dayjs';
import axios from 'axios';
import * as acorn from 'acorn';
import * as cheerio from 'cheerio';
import * as R from 'ramda';
import {isEmpty, isUndefined, map, without} from 'lodash';
import puppeteer, { Browser } from 'puppeteer';

const PORT = Number(process.env.PORT) || 3000;
const COLLECTION = 'stock';
const STOCKS = 'STOCKS';
const STOCK_LIST_UPDATED = 'STOCK_LIST_UPDATED';
const STOCK_IDS_URL = 'https://goodinfo.tw/tw/Lib.js/StockTW_ID_NM_List.js';
const DIVIDEND_PREFIX_URL = 'https://goodinfo.tw/tw/StockDividendPolicy.asp?STOCK_ID=';
const SYSTEM_CHROMIUM_PATH = '/snap/bin/chromium';
const STOCK_LIST_TIMEOUT_MS = 15 * 1000;
// The browser steps add up to less than the 60 seconds the proxy in front of this service waits.
const BROWSER_LAUNCH_TIMEOUT_MS = 15 * 1000;
const PAGE_LOAD_TIMEOUT_MS = 20 * 1000;
const PAGE_REDIRECT_WAIT_MS = 5 * 1000;
const PAGE_BODY_TIMEOUT_MS = 5 * 1000;
const BROWSER_CLOSE_TIMEOUT_MS = 5 * 1000;
const REFRESH_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_RETRY_DELAY_MS = 60 * 1000;
const HTTP_ERROR_STATUS_FROM = 400;
const CHALLENGE_TITLE_PATTERN = /just a moment|請稍候/i;

enum DividendState {
    SUCCESS,
    FAILURE,
    NOTHING
}

interface Dividend {
    [key: string]: DividendState[]
}

interface DividendPage {
    price: string;
    allAvgCashYields: string;
    allAvgRetroactiveYields: string;
    tableHTML: string;
    title: string;
    hasDetailTable: boolean;
}

interface DividendSummary {
    successRate: number;
    allAvgCashYields: number;
    allAvgRetroactiveYields: number;
    amountOfDividend: number;
    amountOfSuccess: number;
    dividendYearStart: number;
    dividendYearEnd: number;
}

/** Fresh data could not be fetched: the source refused or did not answer, or the browser did not start. */
class RefreshFailedError extends Error {}

/**
 * The data source refuses automated requests from time to time. After a failed refresh,
 * stop asking it for a while and answer from the data already stored in MongoDB and Redis.
 */
let refreshRetryAt = 0;

/**
 * One browser at a time. The host is small, and once a refresh has failed,
 * the requests still waiting can skip the source.
 */
let browserQueue: Promise<unknown> = Promise.resolve();

function describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function isRefreshPaused() {
    return Date.now() < refreshRetryAt;
}

function pauseRefresh(error: unknown) {
    refreshRetryAt = Date.now() + REFRESH_RETRY_INTERVAL_MS;
    console.error(`[refresh] failed, using stored data until ${dayjs(refreshRetryAt).format()}: ${describeError(error)}`);
}

function runWithBrowser<T>(task: () => Promise<T>): Promise<T> {
    const result = browserQueue.then(task);
    browserQueue = result.catch(() => undefined);
    return result;
}

/** Close the browser, and kill it when closing does not finish in time, so no process is left behind. */
async function closeBrowser(browser: Browser) {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), BROWSER_CLOSE_TIMEOUT_MS);
    });
    const closed = browser.close().then(() => true, () => false);
    const isClosed = await Promise.race([closed, timedOut]);
    if(timer) clearTimeout(timer);
    if(!isClosed) browser.process()?.kill('SIGKILL');
}

/**
 * The Chrome that puppeteer downloads is built for x86-64 and cannot start on an ARM host,
 * so use the Chromium installed on the system when there is one.
 */
function resolveChromiumPath() {
    const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if(configuredPath) return configuredPath;
    return existsSync(SYSTEM_CHROMIUM_PATH) ? SYSTEM_CHROMIUM_PATH : undefined;
}

/** The front-end calls toFixed() on these three, so all of them have to be real numbers. */
function hasDividendSummary(stock: Record<string, unknown>) {
    const {successRate, allAvgCashYields, allAvgRetroactiveYields} = stock;
    return [successRate, allAvgCashYields, allAvgRetroactiveYields].every((value) => Number.isFinite(value));
}

async function fetchStockList(): Promise<string[]> {
    try {
        const {data: stockIdsText} = await axios.get(STOCK_IDS_URL, { timeout: STOCK_LIST_TIMEOUT_MS });
        const stockIdsParsed = acorn.parse(
            stockIdsText,
            { ecmaVersion: 2020 }
        );

        // TODO: https://github.com/acornjs/acorn/issues/741
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const stocksIdWithNameObject: {value: string}[] = stockIdsParsed.body[0].declarations[0].init.elements;
        const stocksIdWithName = map(stocksIdWithNameObject, 'value');
        return without(stocksIdWithName, '0000 加權指數', '0001 櫃買指數');
    } catch (error) {
        throw new RefreshFailedError(describeError(error));
    }
}

async function loadDividendPage(id: string): Promise<DividendPage> {
    let browser: Browser | undefined;
    try {
        browser = await puppeteer.launch({
            executablePath: resolveChromiumPath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true,
            timeout: BROWSER_LAUNCH_TIMEOUT_MS,
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'accept-language': 'zh-TW,zh;q=0.9' });
        await page.evaluateOnNewDocument(() => {
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        const response = await page.goto(DIVIDEND_PREFIX_URL + id, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: PAGE_REDIRECT_WAIT_MS });
        } catch (_e) {
            // ignore navigation timeout
        }
        await page.waitForSelector('body', { timeout: PAGE_BODY_TIMEOUT_MS });
        const dividendPage = await page.evaluate(() => {
            const getText = (selector: string) => document.querySelector(selector)?.textContent || '';
            return {
                price: getText('body > table:nth-child(9) > tbody > tr:nth-child(2) > td:nth-child(3) > main > table > tbody > tr > td:nth-child(1) > section > table > tbody > tr:nth-child(3) > td:nth-child(1)'),
                allAvgCashYields: getText('#divDividendSumInfo > section > div > table > tbody > tr:nth-child(4) > td:nth-child(5)'),
                allAvgRetroactiveYields: getText('#divDividendSumInfo > section > div > table > tbody > tr:nth-child(6) > td:nth-child(5)'),
                tableHTML: document.querySelector('body')?.outerHTML || '',
                title: document.title,
                hasDetailTable: document.querySelector('#tblDetail') !== null
            };
        });
        const status = response?.status() ?? 0;
        const isRefused = status >= HTTP_ERROR_STATUS_FROM || CHALLENGE_TITLE_PATTERN.test(dividendPage.title);
        if(!dividendPage.hasDetailTable && isRefused) {
            throw new RefreshFailedError(`dividend page for ${id} answered HTTP ${status} ("${dividendPage.title}")`);
        }
        return dividendPage;
    } catch (error) {
        if(error instanceof RefreshFailedError) throw error;
        throw new RefreshFailedError(describeError(error));
    } finally {
        if(browser) await closeBrowser(browser);
    }
}

/** Returns undefined when the page has no usable dividend data. */
function summarizeDividends(dividendPage: DividendPage): DividendSummary | undefined {
    const price = parseFloat(dividendPage.price);
    const allAvgCashYields = parseFloat(dividendPage.allAvgCashYields);
    const allAvgRetroactiveYields = parseFloat(dividendPage.allAvgRetroactiveYields);
    if (isNaN(price) || allAvgRetroactiveYields === 0 || isNaN(allAvgRetroactiveYields)) {
        return undefined;
    }

    let yearText:string;
    let year:number;
    const $ = cheerio.load(dividendPage.tableHTML);
    const $trs = $('#tblDetail > tbody > tr');
    const dividends: Dividend = {};
    for(let i = 4; i < $trs.length - 1; i++) {
        let dividendState: DividendState = DividendState.NOTHING; 
        const $dividendTr = $trs.eq(i);
        yearText = $dividendTr.children('td').eq(0).text();
        const parsedYear = parseInt(yearText, 10);
        if(!Number.isNaN(parsedYear)) {
            year = parsedYear;
            dividends[year] = [];
        } else if(yearText !== '∟') {
            continue;
        }
        const cashDividendText = $dividendTr.children('td').eq(3).text();
        const stockDividendText = $dividendTr.children('td').eq(6).text();
        const cashDividendSpendDaysText = $dividendTr.children('td').eq(10).text();
        const stockDividendSpendDaysText = $dividendTr.children('td').eq(11).text();
        if(cashDividendText !== '0' && cashDividendText !== '-') {
            if(cashDividendSpendDaysText !== '-') dividendState = DividendState.SUCCESS;
            else dividendState = DividendState.FAILURE;
        }
        if(stockDividendText !== '0' && stockDividendText !== '-' && dividendState !== DividendState.FAILURE) {
            if(stockDividendSpendDaysText !== '-') dividendState = DividendState.SUCCESS;
            else dividendState = DividendState.FAILURE;
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        dividends[year!].push(dividendState);
    }
    const dividendsValues = R.values(dividends);
    const dividendsYears = R.keys(dividends).map((y) => parseInt(String(y), 10));
    const amountOfDividend = dividendsValues.length;
    if(amountOfDividend === 0) {
        return undefined;
    }

    const dividendsFailureObject = R.filter(value => {
        if(value.length === 1) {
            if(value[0] === DividendState.FAILURE) return true;
            else return false;
        }

        return R.any(R.equals(1))( R.splitAt(1, value)[1]);

    }, dividends);
    const dividendsFailures = R.keys(dividendsFailureObject);
    const amountOfSuccess = amountOfDividend - dividendsFailures.length;
    const successRate = (amountOfSuccess / amountOfDividend) * 100.00;
    const dividendYearStart = dividendsYears[0];
    const dividendYearEnd = dividendsYears[amountOfDividend - 1];

    return {
        successRate,
        allAvgCashYields,
        allAvgRetroactiveYields,
        amountOfDividend,
        amountOfSuccess,
        dividendYearStart,
        dividendYearEnd
    };
}

(async ()=> {
    const mongodbClient = await mongodbConnect();
    const redisClient = await redisConnect();
    const app = express();
    app.use(cors({credentials:true}));

    const storeStockList = async (stocks: string[]) => {
        const stockUpsertIdAndNameFunction = async (stockIdWithName: string) => {
            const [id, name] = stockIdWithName.split(' ');
            await mongodbClient.collection(COLLECTION).updateOne({
                id
            }, {
                $set: { 
                    name, 
                },
                $currentDate: { updated: true },
            }, {
                upsert: true,
            });
        };
        Promise.all(map(stocks, stockUpsertIdAndNameFunction))
            .catch((error) => console.error(`[stocks] saving the list to MongoDB failed: ${describeError(error)}`));
        await redisClient.sAdd(STOCKS, stocks);
        await redisClient.set(STOCK_LIST_UPDATED, dayjs().toString());
    };

    app.get('/stock', async function (req, res) {
        try {
            const { search } = req.query as {search:string};
            if(isEmpty(search)) return res.sendStatus(404);
            const stock = await mongodbClient.collection(COLLECTION).findOne({
                $or:[{id:search},{name:search}]
            });
            if(stock === null || isEmpty(stock)) return res.sendStatus(404);
            const {id, name, successRate, updated} = stock;
            // When there is no fresh data, answer with what is already stored.
            const sendStoredOrNotFound = () => hasDividendSummary(stock) ? res.send(stock) : res.sendStatus(404);
            const isRefreshDue = isUndefined(successRate) || dayjs().isAfter(updated, 'M');
            if(!isRefreshDue || isRefreshPaused()) return sendStoredOrNotFound();

            let dividendSummary: DividendSummary | undefined;
            try {
                dividendSummary = await runWithBrowser(async () => {
                    // A request ahead of this one in the queue may have failed in the meantime.
                    if(isRefreshPaused()) return undefined;
                    return summarizeDividends(await loadDividendPage(id));
                });
            } catch (error) {
                if(!(error instanceof RefreshFailedError)) throw error;
                pauseRefresh(error);
                return sendStoredOrNotFound();
            }
            if(isUndefined(dividendSummary)) return sendStoredOrNotFound();

            await mongodbClient.collection(COLLECTION).updateOne({
                id
            }, {
                $set: { 
                    name, 
                    ...dividendSummary
                },
                $currentDate: { updated: true },
            }, {
                upsert: true,
            });
            const refreshedStock = {...stock, ...dividendSummary};
            if(!hasDividendSummary(refreshedStock)) return res.sendStatus(404);
            res.send(refreshedStock);
        } catch (error) {
            console.error(`[stock] ${describeError(error)}`);
            res.sendStatus(500);
        }
    });

    app.get('/stocks', async function (req, res) {
        try {
            const stockListUpdatedString = await redisClient.get(STOCK_LIST_UPDATED);
            const isRefreshDue = isEmpty(stockListUpdatedString) || dayjs().isAfter(stockListUpdatedString, 'M');
            let stocks: string[] = [];
            if(isRefreshDue && !isRefreshPaused()) {
                try {
                    stocks = await fetchStockList();
                    await storeStockList(stocks);
                } catch (error) {
                    if(!(error instanceof RefreshFailedError)) throw error;
                    pauseRefresh(error);
                }
            }

            if(isEmpty(stocks)) stocks = await redisClient.sMembers(STOCKS);
            if(isEmpty(stocks)) return res.sendStatus(503);

            res.send(stocks);
        } catch (error) {
            console.error(`[stocks] ${describeError(error)}`);
            res.sendStatus(500);
        }
    });
    
    app.listen(PORT);
})().catch((error) => {
    // Leave on purpose so the process manager starts it again, e.g. when MongoDB was not up yet.
    console.error(`[startup] ${describeError(error)}, exiting in ${STARTUP_RETRY_DELAY_MS / 1000} seconds`);
    setTimeout(() => process.exit(1), STARTUP_RETRY_DELAY_MS);
});
