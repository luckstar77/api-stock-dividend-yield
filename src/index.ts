import express from 'express';
import { connect as mongodbConnect } from './db/mongodb';
import { connect as redisConnect } from './db/redis';
import cors from 'cors';
import dayjs from 'dayjs';
import axios from 'axios';
import * as acorn from 'acorn';
import * as cheerio from 'cheerio';
import * as R from 'ramda';
import {isEmpty, isUndefined, map, without} from 'lodash';

const COLLECTION = 'stock';
const STOCKS = 'STOCKS';
const STOCK_LIST_UPDATED = 'STOCK_LIST_UPDATED';
const STOCK_IDS_URL = 'https://goodinfo.tw/tw/Lib.js/StockTW_ID_NM_List.js';
const DIVIDEND_PREFIX_URL = 'https://goodinfo.tw/tw/StockDividendPolicy.asp?STOCK_ID=';

enum DividendState {
    SUCCESS,
    FAILURE,
    NOTHING
}

interface Dividend {
    [key: string]: DividendState[]
}

(async ()=> {
    const mongodbClient = await mongodbConnect();
    const redisClient = await redisConnect();
    const app = express();
    app.use(cors({credentials:true}));

    app.get('/stock', async function (req, res) {
        const { search } = req.query as {search:string};
        if(isEmpty(search)) return res.sendStatus(404);
        let stock = await mongodbClient.collection(COLLECTION).findOne({
            $or:[{id:search},{name:search}]
        });
        if(isEmpty(stock)) return res.sendStatus(404);
        const {id, name, successRate, updated} = stock;
        if(isUndefined(successRate) || dayjs().isAfter(updated, 'M')) {
            // TODO: https://github.com/acornjs/acorn/issues/741
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const {data: dividendText} = await axios.get(DIVIDEND_PREFIX_URL + id);
            const $ = cheerio.load(dividendText);
            const price = parseFloat($('body > table:nth-child(8) > tbody > tr > td:nth-child(3) > table:nth-child(1) > tbody > tr > td:nth-child(1) > table > tbody > tr:nth-child(3) > td:nth-child(1)').text());
            const allAvgCashYields = parseFloat($('#divDividendSumInfo > div > div > table > tbody > tr:nth-child(4) > td:nth-child(5)').text());
            const allAvgRetroactiveYields = parseFloat($('#divDividendSumInfo > div > div > table > tbody > tr:nth-child(6) > td:nth-child(5)').text());
            if (isNaN(price) || allAvgRetroactiveYields === 0 || isNaN(allAvgRetroactiveYields)) {
                return res.sendStatus(404);
            }

            let yearText:string;
            let year:number;
            const $trs = $('#tblDetail > tbody > tr');
            const dividends: Dividend = {};
            for(let i = 4; i < $trs.length - 1; i++) {
                let dividendState: DividendState = DividendState.NOTHING; 
                const $dividendTr = $trs.eq(i);
                yearText = $dividendTr.children('td').eq(0).text();
                if(!isNaN(yearText as never)) {
                    year = parseInt(yearText);
                    dividends[year] = [];
                } else if(yearText !== '∟') continue;
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
            const dividendsYears = R.keys(dividends);
            const amountOfDividend = dividendsValues.length;
            if(amountOfDividend === 0) {
                return res.sendStatus(404);
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

            const updated = await mongodbClient.collection(COLLECTION).updateOne({
                id
            }, {
                $set: { 
                    name, 
                    successRate,
                    allAvgCashYields,
                    allAvgRetroactiveYields,
                    amountOfDividend,
                    amountOfSuccess,
                    dividendYearStart,
                    dividendYearEnd
                },
                $currentDate: { updated: true },
            }, {
                upsert: true,
            });
            stock = {...stock,
                successRate,
                allAvgCashYields,
                allAvgRetroactiveYields,
                amountOfDividend,
                amountOfSuccess,
                dividendYearStart,
                dividendYearEnd};
        }
        res.send(stock);
    });

    app.get('/stocks', async function (req, res) {
        const stockListUpdatedString = await redisClient.get(STOCK_LIST_UPDATED);
        let stocks:any;
        if(isEmpty(stockListUpdatedString) || dayjs().isAfter(stockListUpdatedString, 'M')) {
            const {data: stockIdsText} = await axios.get(STOCK_IDS_URL);
            const stockIdsParsed = acorn.parse(
                stockIdsText,
                { ecmaVersion: 2020 }
            );
            
            // TODO: https://github.com/acornjs/acorn/issues/741
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const stocksIdWithNameObject: {value: string}[] = stockIdsParsed.body[0].declarations[0].init.elements;
            const stocksIdWithName = map(stocksIdWithNameObject, 'value');
            stocks = without(stocksIdWithName, '0000 加權指數', '0001 櫃買指數');
            const stockUpsertIdAndNameFunction = async (stockIdWithName: string) => {
                const [id, name] = stockIdWithName.split(' ');
                const updated = await mongodbClient.collection(COLLECTION).updateOne({
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
            Promise.all(map(stocks, stockUpsertIdAndNameFunction));
            await redisClient.sAdd(STOCKS, stocks);
            await redisClient.set(STOCK_LIST_UPDATED, dayjs().toString());
        }

        if(isEmpty(stocks)) stocks = await redisClient.sMembers(STOCKS);
        
        res.send(stocks);
    });
    
    app.listen(3000);
})();