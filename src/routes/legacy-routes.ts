import { Router } from 'express';
import { describeError } from '../sources/rate-limited-client';
import { StockService } from '../services/stock-service';

const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const HTTP_UNAVAILABLE = 503;

/**
 * The routes the first front-end calls, kept exactly as they were until every client uses /v1.
 * GET /stock?search=2330 answers the stored document; GET /stocks answers the "id name" entries.
 */
export function createLegacyRouter(stockService: StockService): Router {
    const router = Router();

    router.get('/stock', async (req, res) => {
        try {
            const { search } = req.query;
            if(typeof search !== 'string' || search === '') return res.sendStatus(HTTP_NOT_FOUND);
            const stock = await stockService.findLegacyStock(search);
            if(stock === null) return res.sendStatus(HTTP_NOT_FOUND);
            res.send(stock);
        } catch (error) {
            console.error(`[stock] ${describeError(error)}`);
            res.sendStatus(HTTP_SERVER_ERROR);
        }
    });

    router.get('/stocks', async (req, res) => {
        try {
            const stocks = await stockService.getLegacyStockEntries();
            if(stocks.length === 0) return res.sendStatus(HTTP_UNAVAILABLE);
            res.send(stocks);
        } catch (error) {
            console.error(`[stocks] ${describeError(error)}`);
            res.sendStatus(HTTP_SERVER_ERROR);
        }
    });

    return router;
}
