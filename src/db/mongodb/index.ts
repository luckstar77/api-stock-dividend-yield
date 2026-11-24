import { MongoClient } from 'mongodb';

// Connection URL
const url = 'mongodb://localhost:27017';
// Fail fast instead of keeping a request waiting for 30 seconds when MongoDB is down.
const SERVER_SELECTION_TIMEOUT_MS = 5000;
const client = new MongoClient(url, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });

// Database Name
const dbName = 'inventory';

export async function connect() {
    // TODO: error handler
  
    // Use connect method to connect to the server
    await client.connect();
    console.log('Connected successfully to server');
    const db = client.db(dbName);
    // const collection = db.collection('stock');

    // the following code examples can be pasted here...

    return db;
}
