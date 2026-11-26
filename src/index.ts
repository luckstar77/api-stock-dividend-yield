import { createApp } from './app';
import { PORT, STARTUP_RETRY_DELAY_MS } from './config';
import { connect as mongodbConnect } from './db/mongodb';
import { connect as redisConnect } from './db/redis';
import { MongoStockRepository } from './repositories/stock-repository';
import { RedisStockListRepository } from './repositories/stock-list-repository';
import { StockService } from './services/stock-service';
import { describeError } from './sources/rate-limited-client';

/**
 * Answers from the data in MongoDB and Redis. build/sync.js keeps that data up to date
 * from the TWSE and TPEx open data once a day (see README).
 */
async function main() {
    const db = await mongodbConnect();
    const redisClient = await redisConnect();
    const stockRepository = new MongoStockRepository(db);
    await stockRepository.ensureIndexes();
    const stockService = new StockService(stockRepository, new RedisStockListRepository(redisClient));
    createApp({ stockService }).listen(PORT, () => console.log(`[startup] listening on port ${PORT}`));
}

main().catch((error) => {
    // Leave on purpose so the process manager starts it again, e.g. when MongoDB was not up yet.
    console.error(`[startup] ${describeError(error)}, exiting in ${STARTUP_RETRY_DELAY_MS / 1000} seconds`);
    setTimeout(() => process.exit(1), STARTUP_RETRY_DELAY_MS);
});
