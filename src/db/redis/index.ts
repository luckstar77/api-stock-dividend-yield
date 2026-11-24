import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;

// Same pacing as the node-redis default: 50 ms more per attempt, at most 500 ms.
const RECONNECT_STEP_MS = 50;
const RECONNECT_MAX_DELAY_MS = 500;

/**
 * maxRetries: give up after this many failed connection attempts instead of trying for ever.
 * The API server keeps trying; build/sync.js gives up, so a run cannot hang on Redis.
 */
export async function connect(options: { maxRetries?: number } = {}): Promise<RedisClient> {
    const { maxRetries } = options;

    // Without disableOfflineQueue, a command sent while Redis is down waits until it is back,
    // and the request that sent it never gets a response.
    // REDIS_DATABASE lets a trial run of the sync write to another database number.
    const client = createClient({
        disableOfflineQueue: true,
        database: Number(process.env.REDIS_DATABASE) || 0,
        socket: {
            reconnectStrategy: (retries) => (maxRetries !== undefined && retries >= maxRetries ? new Error(`Redis not reachable after ${retries} attempts`) : Math.min(retries * RECONNECT_STEP_MS, RECONNECT_MAX_DELAY_MS)),
        },
    });
    
    client.on('error', (err) => console.log('Redis Client Error', err));
    
    await client.connect();

    return client;
}
