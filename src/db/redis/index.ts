import { createClient } from 'redis';

export async function connect() {

    // Without this, a command sent while Redis is down waits until it is back,
    // and the request that sent it never gets a response.
    const client = createClient({ disableOfflineQueue: true });
    
    client.on('error', (err) => console.log('Redis Client Error', err));
    
    await client.connect();

    return client;
} 