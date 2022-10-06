import express from 'express';
import { connect as mongodbConnect } from './db/mongodb';

const COLLECTION = 'stock';

(async ()=> {
    const mongodbClient = await mongodbConnect();
    const app = express();
    
    app.get('/stock', async function (req, res) {
        const { search } = req.query;
        const stock = await mongodbClient.collection(COLLECTION).findOne({
            $or:[{id: search},{name: search}]
        });
        res.send(stock);
    });
    
    app.listen(3000);
})();