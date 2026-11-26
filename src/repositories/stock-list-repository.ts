import { RedisClient } from '../db/redis';

/** Written by build/sync.js: a set of "id name" entries and the trading day they come from. */
const STOCKS = 'STOCKS';
const STOCK_LIST_UPDATED = 'STOCK_LIST_UPDATED';

export interface StockListRepository {
    /** "id name" entries, in no particular order */
    findEntries(): Promise<string[]>;
    /** The trading day of the list, YYYY-MM-DD */
    findListDate(): Promise<string | null>;
    ping(): Promise<void>;
}

export class RedisStockListRepository implements StockListRepository {
    constructor(private readonly client: RedisClient) {}

    findEntries(): Promise<string[]> {
        return this.client.sMembers(STOCKS);
    }

    findListDate(): Promise<string | null> {
        return this.client.get(STOCK_LIST_UPDATED);
    }

    async ping(): Promise<void> {
        await this.client.ping();
    }
}
