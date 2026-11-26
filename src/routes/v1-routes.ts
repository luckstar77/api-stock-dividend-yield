import { Request, Response, Router } from 'express';
import { sendInvalidInput, sendNoData, sendNotFound, sendServerError, sendSuccess } from '../http/response';
import { describeError } from '../sources/rate-limited-client';
import { StockService } from '../services/stock-service';

type Handler = (req: Request, res: Response) => Promise<void>;

/** Express 4 does not catch a rejected async handler, so every route answers its own failures. */
function handle(label: string, handler: Handler) {
    return async (req: Request, res: Response) => {
        try {
            await handler(req, res);
        } catch (error) {
            console.error(`[${label}] ${describeError(error)}`);
            sendServerError(res);
        }
    };
}

/**
 * GET /v1/health
 * GET /v1/stocks                        the search box list
 * GET /v1/stocks/dividends?keyword=2330 one stock's summary and year-by-year history
 */
export function createV1Router(stockService: StockService): Router {
    const router = Router();

    router.get('/health', handle('v1 health', async (req, res) => {
        sendSuccess(res, await stockService.checkHealth(), false);
    }));

    router.get('/stocks', handle('v1 stocks', async (req, res) => {
        const stockList = await stockService.getStockList();
        if(stockList.list.length === 0) return sendNoData(res, stockList);
        sendSuccess(res, stockList);
    }));

    router.get('/stocks/dividends', handle('v1 stock dividends', async (req, res) => {
        const { keyword } = req.query;
        const trimmed = typeof keyword === 'string' ? keyword.trim() : '';
        if(trimmed === '') return sendInvalidInput(res, 'keyword is required: a stock id or name');
        const dividends = await stockService.getStockDividends(trimmed);
        if(dividends === null) return sendNoData(res);
        sendSuccess(res, dividends);
    }));

    router.use((req, res) => sendNotFound(res));

    return router;
}
