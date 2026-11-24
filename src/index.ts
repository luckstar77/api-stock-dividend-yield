import express from 'express';
import cors from 'cors';
import { connect as mongodbConnect } from './db/mongodb';
import { connect as redisConnect } from './db/redis';
import { describeError } from './sources/rate-limited-client';

/**
 * Answers from the data in MongoDB and Redis. build/sync.js keeps that data up to date
 * from the TWSE and TPEx open data once a day (see README).
 */

const PORT = Number(process.env.PORT) || 3000;
const COLLECTION = 'stock';
const STOCKS = 'STOCKS';
const STARTUP_RETRY_DELAY_MS = 60 * 1000;

/** The front-end calls toFixed() on these three, so all of them have to be real numbers. */
function hasDividendSummary(stock: Record<string, unknown>) {
    const {successRate, allAvgCashYields, allAvgRetroactiveYields} = stock;
    return [successRate, allAvgCashYields, allAvgRetroactiveYields].every((value) => Number.isFinite(value));
}

(async ()=> {
    const mongodbClient = await mongodbConnect();
    const redisClient = await redisConnect();
    const app = express();
    app.use(cors({credentials:true}));

    app.get('/stock', async function (req, res) {
        try {
            const { search } = req.query;
            if(typeof search !== 'string' || search === '') return res.sendStatus(404);
            const stock = await mongodbClient.collection(COLLECTION).findOne({
                $or:[{id:search},{name:search}]
            });
            if(stock === null || !hasDividendSummary(stock)) return res.sendStatus(404);
            res.send(stock);
        } catch (error) {
            console.error(`[stock] ${describeError(error)}`);
            res.sendStatus(500);
        }
    });

    app.get('/stocks', async function (req, res) {
        try {
            const stocks = await redisClient.sMembers(STOCKS);
            if(stocks.length === 0) return res.sendStatus(503);
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
