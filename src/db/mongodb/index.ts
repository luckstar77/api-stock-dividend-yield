import { MongoClient } from 'mongodb';

// Connection URL. MONGODB_URL lets a local run use another server.
const url = process.env.MONGODB_URL || 'mongodb://localhost:27017';
// Fail fast instead of keeping a request waiting for 30 seconds when MongoDB is down.
const SERVER_SELECTION_TIMEOUT_MS = 5000;
const client = new MongoClient(url, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });

// Database Name. MONGODB_DB_NAME lets a trial run of the sync write somewhere else.
const dbName = process.env.MONGODB_DB_NAME || 'inventory';

export async function connect() {
    await client.connect();
    console.log('Connected successfully to server');
    return client.db(dbName);
}

export async function disconnect() {
    await client.close();
}
