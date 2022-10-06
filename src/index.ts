import express from "express"
const app = express()

app.get('/stock', function (req, res) {
    const { search } = req.query
  res.send('Hello World')
})

app.listen(3000)