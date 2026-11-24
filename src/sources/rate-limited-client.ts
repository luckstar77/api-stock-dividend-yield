import axios from 'axios';

const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60 * 1000;
const USER_AGENT = 'stock-dividend-yield (+https://github.com/luckstar77/api-stock-dividend-yield)';

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends one request at a time to a host and waits between requests.
 * The exchanges block an address that sends requests too quickly.
 */
export class RateLimitedClient {
    private queue: Promise<unknown> = Promise.resolve();
    private lastRequestAt = 0;

    constructor(private readonly minIntervalMs: number) {}

    getJson(url: string): Promise<unknown> {
        const result = this.queue.then(() => this.getWithRetry(url));
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async getWithRetry(url: string): Promise<unknown> {
        for(let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                return await this.get(url);
            } catch (error) {
                console.warn(`[sync] GET ${url} failed (${describeError(error)}), trying again in ${RETRY_DELAY_MS / 1000} s`);
                await sleep(RETRY_DELAY_MS);
            }
        }
        return this.get(url);
    }

    private async get(url: string): Promise<unknown> {
        await this.waitForTurn();
        const { data } = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT } });
        // axios hands back the text when the body is not JSON, e.g. an error page.
        if(typeof data === 'string') throw new Error(`not JSON: ${data.slice(0, 80)}`);
        return data;
    }

    private async waitForTurn(): Promise<void> {
        const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
        if(wait > 0) await sleep(wait);
        this.lastRequestAt = Date.now();
    }
}
