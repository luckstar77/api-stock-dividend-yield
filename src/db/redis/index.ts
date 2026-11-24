import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;

export async function connect(): Promise<RedisClient> {

    // Without this, a command sent while Redis is down waits until it is back,
    // and the request that sent it never gets a response.
    // REDIS_DATABASE lets a trial run of the sync write to another database number.
    const client = createClient({ disableOfflineQueue: true, database: Number(process.env.REDIS_DATABASE) || 0 });
    
    client.on('error', (err) => console.log('Redis Client Error', err));
    
    await client.connect();

    return client;
}
