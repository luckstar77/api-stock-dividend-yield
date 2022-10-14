import express from 'express';
import { connect as mongodbConnect } from './db/mongodb';
import cors from 'cors';

const COLLECTION = 'stock';

(async ()=> {
    const mongodbClient = await mongodbConnect();
    const app = express();
    app.use(cors({credentials:true}));

    app.get('/stock', async function (req, res) {
        const { search } = req.query;
        const stock = await mongodbClient.collection(COLLECTION).findOne({
            $or:[{id: search},{name: search}]
        });
        res.send(stock);
    });
    
    app.listen(3000);
})();