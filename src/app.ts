import express, { Express } from 'express';
import cors from 'cors';
import { createLegacyRouter } from './routes/legacy-routes';
import { createV1Router } from './routes/v1-routes';
import { StockService } from './services/stock-service';

export interface AppDependencies {
    stockService: StockService;
}

/** Builds the HTTP app from its dependencies, so tests can run it on fake repositories. */
export function createApp({ stockService }: AppDependencies): Express {
    const app = express();
    app.disable('x-powered-by');
    // A public read-only API without cookies: any origin may read it, no credentials.
    app.use(cors());
    app.use(createLegacyRouter(stockService));
    app.use('/v1', createV1Router(stockService));
    return app;
}
