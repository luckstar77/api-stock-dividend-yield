import { Db } from 'mongodb';
import { TrackedDividendEvent } from '../dividend/summary';

const STOCK_COLLECTION = 'stock';
const EVENT_COLLECTION = 'dividend_event';

/**
 * A stored document of the stock collection, as build/sync.js wrote it.
 * Documents saved before the move to the exchange data (from goodinfo) may miss fields or keep numbers as strings,
 * so the values are unknown until checked.
 */
export type StockDocument = Record<string, unknown>;

export interface StockRepository {
    /** Finds a stock by its id or its exact name. */
    findStockByKeyword(keyword: string): Promise<StockDocument | null>;
    /** The stock's ex-dates, oldest first */
    findDividendEvents(id: string): Promise<TrackedDividendEvent[]>;
    ping(): Promise<void>;
}

export class MongoStockRepository implements StockRepository {
    constructor(private readonly db: Db) {}

    /** The unique index build/sync.js makes starts with market, so it cannot serve a lookup by id alone. */
    async ensureIndexes(): Promise<void> {
        await this.db.collection(EVENT_COLLECTION).createIndex({ id: 1, date: 1 });
    }

    findStockByKeyword(keyword: string): Promise<StockDocument | null> {
        return this.db.collection(STOCK_COLLECTION).findOne({ $or: [{ id: keyword }, { name: keyword }] });
    }

    findDividendEvents(id: string): Promise<TrackedDividendEvent[]> {
        return this.db.collection<TrackedDividendEvent>(EVENT_COLLECTION)
            .find({ id }, { projection: { _id: 0, detailFailures: 0, estimatedAmount: 0, needsRecheck: 0 } })
            .sort({ date: 1 })
            .toArray();
    }

    async ping(): Promise<void> {
        await this.db.command({ ping: 1 });
    }
}
