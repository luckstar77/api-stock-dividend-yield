## 流程
- 連接 mongodb
- 建立 koa 連線
- 建立API查詢 ID 或名稱取得資料
  - 確認是否有最近一個月內的資料
  - 若有則拿取
  - 若沒有則使用爬蟲
  - 填權息成功率
  - 除權息次數
  - 填權息次數
  - 統計年分
  - 歷年平均現金殖利率
  - 歷年平均還原殖利率
- 建立API取得所有股票ID與名稱列表
  - 確認是否有最近一個月內的列表
  - 若有則拿取
  - 若沒有則使用爬蟲

## 資料庫
- mongodb
  - stock
    - id `string`
    - name `string`
    - successRate `double`
    - allAvgCashYields `double`
    - allAvgRetroactiveYields `double`
    - amountOfDividend `double`
    - amountOfSuccess `double`
    - dividendYearStart `int`
    - dividendYearEnd `int`
- redis
  - STOCK_LIST_UPDATED `int`

## 開發流程
- sudo service mongodb start
- sudo service redis-server start
- npm i -g pm2 typescript
- tsc
- pm2 start build/index.js

## 參考第三方 API
- 取得GOODINFO網站的股票ID資訊 <https://goodinfo.tw/tw/Lib.js/TW_STOCK_ID_NM_LIST.js>  
```
/*檔案更新時間:2022/09/21 06:03:22*/
var garrTW_LIST_STOCK_ID_NM = []
var garrTW_LIST_STOCK_ID = []  //取得股票ID
var garrTW_LIST_STOCK_NM = []
```

---

- 取得GOODINFO的股票年均殖利率資訊 https://goodinfo.tw/tw/StockDividendPolicy.asp?STOCK_ID=2330  

```
// 股價
document.querySelector("body > table:nth-child(8) > tbody > tr > td:nth-child(3) > table:nth-child(1) > tbody > tr > td:nth-child(1) > table > tbody > tr:nth-child(3) > td:nth-child(1)")

// 歷年平均殖利率
document.querySelector("#divDividendSumInfo > div > div > table > tbody > tr:nth-child(6) > td:nth-child(5)")

// 發放股利年份（需判斷年份是否重複，重複則繼續直到找到下一個年份，並計算同一年份是否全都有填權息）
document.querySelector("#tblDetail > tbody > tr:nth-child(5) > td:nth-child(1) > nobr > b")

// 年均殖利率
document.querySelector("#tblDetail > tbody > tr:nth-child(5) > td:nth-child(19)")

// 填息天數
document.querySelector("#tblDetail > tbody > tr:nth-child(5) > td:nth-child(11)")

// 填權天數
document.querySelector("#tblDetail > tbody > tr:nth-child(5) > td:nth-child(12)")
```

## 公式
- 現金殖利率公式 =（現金股利 ÷ 除權息前一日收盤價）
- 除權息參考價公式 = (除權息前一日收盤價 - 現金股利 ) ÷ ( 1 +（股票股利 ÷ 10）)
- 配股 = 股票股利 x 100
- 配股價值公式 = 配股 x 除權息參考價
- 還原殖利率公式 =（現金股利 + 配股價值）÷ 除權息前一日收盤價

## nginx 設定
sudo vim /etc/nginx/sites-enabled/api.stock.imallenlai.com
```
server {
        listen       80;
        server_name  api.stock.imallenlai.com;
        
      
        location / {
            proxy_pass http://127.0.0.1:3000;
        }
    }
```

## 技術文章參考
- [certbot](https://www.digitalocean.com/community/tutorials/how-to-secure-nginx-with-let-s-encrypt-on-ubuntu-20-04)
- [nginx](https://andy6804tw.github.io/2022/02/27/nginx-tutorial/)

## 資料來源抓不到時的行為
goodinfo.tw 會擋自動化的請求（回 403 或驗證頁）。抓不到的時候：
- `/stocks` 回傳 Redis 裡已經存的股票清單
- `/stock` 回傳 MongoDB 裡已經存的資料；那檔股票沒有存過股利資料才回 404
- 失敗之後 24 小時內不再向來源發請求（重啟程式會重新計時）
- 一次只開一個瀏覽器；瀏覽器在主機上起不來時，也當成抓不到處理（log 會寫出原因）
- Redis 或 MongoDB 連不上時回 500，不會讓請求一直等

## 部署
主機上要用 Node.js 20。主機預設是 Node 18，而目前裝在主機上的 cheerio 1.1 需要 Node 20.18 以上，用 Node 18 啟動會在載入套件時就結束。
```
nvm use 20
git pull
npm i
tsc
pm2 restart stock
```
- `PORT`：監聽的埠，預設 3000
- `PUPPETEER_EXECUTABLE_PATH`：Chromium 的路徑。沒有設定時，主機上有 `/snap/bin/chromium` 就用它；puppeteer 自己下載的 Chrome 是 x86-64 版，ARM 主機不能用

## EC2 主機重啟後初始指令
redis-server 與 mongod 已經設成開機自動啟動，前兩行通常不用做。pm2 沒有設開機啟動，所以後端要手動啟動，而且要先切到 Node 20。
```
sudo systemctl start redis-server
sudo systemctl start mongod
nvm use 20
cd stock-dividend-yield/api-stock-dividend-yield
pm2 start build/index.js --name stock
```