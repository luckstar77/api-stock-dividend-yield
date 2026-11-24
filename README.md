## 資料來源
資料來自臺灣證券交易所（上市）與證券櫃檯買賣中心（上櫃）的公開資料，由 `build/sync.js` 每天傍晚更新一次。原本的來源 goodinfo.tw 會擋自動存取，所以改用交易所的資料。

- 除權除息計算結果表：除權息日、除權息前收盤價、參考價
- 除權除息的詳細資料（只有上市）：每股現金股利、每千股無償配股
- 每日收盤行情：用來判斷有沒有填權息

## 統計方式
- 填權息：除權息日當天或之後，第一次收盤價回到「除權息前收盤價」以上，就算填權息。
- 除權息次數、填權息次數：以年為單位。一年內所有的除權息都填了，那一年才算填權息成功。
- 現金殖利率、還原殖利率：照下面「公式」一節算出每次除權息的殖利率，同一年加總，再把各年平均。
- 現金增資（要付錢認購的除權）不是股利，不算進去。

和以前（goodinfo）的差別：

- 統計從上市 2004 年 2 月、上櫃 2007 年 12 月開始，因為交易所的每日收盤行情只提供到這裡。以前最早可以到 1990 年代。
- 以前顯示的殖利率是 goodinfo 網站算好的數字，現在照「公式」一節自己算，數字會有差異。
- 上市 2004、2005 年有些除權息查不到詳細資料，這些的配股數是用表格的息值與價格推算的，分不出同一天的現金增資。

## 流程
- `build/sync.js`（每天 18:30 由 systemd timer 執行，見 `deploy/`）
  - 讀取除權除息計算結果表，存進 `dividend_event`
  - 有配股的除權息，從詳細資料補上現金股利與配股數
  - 從上次停下的那天起，逐日讀取收盤價，標記已填權息的除權息
  - 算出每檔股票的統計，寫進 `stock`；最新一個交易日的上市、上櫃清單寫進 Redis 的 `STOCKS`
  - 第一次執行要讀 2004 年以後的每個交易日，大約要半天；每處理完一天就存進度，中斷了下次會接著做
- API（`build/index.js`）只讀資料庫
  - `GET /stock?search=2330`：用代號或名稱查一檔股票的統計
  - `GET /stocks`：搜尋框用的股票清單

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
    - source `string`：`twse-tpex`；沒有這個欄位的是以前從 goodinfo 抓的
    - dataThrough `string`：收盤價檢查到哪一天
  - dividend_event：每檔股票的每次除權息與填權息日
  - sync_state：`build/sync.js` 的進度
- redis
  - STOCKS `set`：「代號 名稱」
  - STOCK_LIST_UPDATED `string`：清單是哪一個交易日的

## 開發流程
- sudo service mongodb start
- sudo service redis-server start
- npm i -g pm2 typescript
- npm i
- npm test（編譯並執行單元測試）
- pm2 start build/index.js

## 使用的公開資料
- 上市除權除息計算結果表 <https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=20240101&endDate=20241231&response=json>
- 上市除權除息詳細資料 <https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail?STK_NO=2454&T1=20240104&response=json>
- 上市每日收盤行情 <https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=20240102&type=ALLBUT0999&response=json>
- 上櫃除權除息計算結果表 <https://www.tpex.org.tw/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d=113/01/01&ed=113/12/31>
- 上櫃每日收盤行情 <https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=113/01/02&se=EW&o=json>

櫃買中心的日期要寫三位數的民國年（例如 `096/07/02`）；不接受的日期會直接回最新一天的資料，所以程式會檢查回應的日期。交易所會封鎖太頻繁的請求，程式對同一個網站一次只送一個請求，每個請求的開始時間至少相隔 3 秒。

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
- API 只讀資料庫，來源抓不到不影響查詢，顯示的是最後一次更新的資料。
- `build/sync.js` 的請求失敗時，等 60 秒再試，最多 3 次；還是失敗就停下，systemd 30 分鐘後重跑，從停下的那天接著做。
- 回應的格式不對（例如被限流時回的錯誤頁、日期對不上），程式會停下等下次重跑，不會把錯誤的內容存成資料。表格裡少數讀不懂的列會略過並寫警告（2004–2026 年每張表最多 1 列）；同一張表超過 5 列讀不懂，就當成格式變了而停下。
- 詳細資料頁回了讀不懂的內容：不存任何金額，留到下次再問，那支股票先維持原本的統計。讀不懂過的排到後面再問，所以一頁一直壞也不會擋住其他的。連續 5 頁都讀不懂，就當成網站在回錯誤，其餘的留到下次。
- 最近 7 天內有一天只有一個市場有收盤價：先再問一次，還是沒有就只處理到前一天，照常更新統計，隔天的排程再試。更早的日子再問也不會補上，就略過那個市場並寫警告。
- 詳細資料明確回「無相關資料」、表格也沒有息值可以推算的除權息，不算進統計，log 會列出。
- 較晚才公布、日期落在已經檢查過的日子的除權息，下次執行會從那天起重新檢查收盤價。
- Redis 或 MongoDB 連不上時 API 回 500，不會讓請求一直等。

## 部署
主機上用 Node.js 20（主機預設是 Node 18）。
```
nvm use 20
git pull
npm i
npm test
pm2 restart stock
```
- `PORT`：監聽的埠，預設 3000
- 每日更新的 systemd 設定在 `deploy/`，安裝方式寫在 `deploy/stock-dividend-sync.service` 的開頭。看進度：`journalctl -u stock-dividend-sync -f`
- 試跑時不要寫進正式的資料：`MONGODB_DB_NAME=inventory_trial REDIS_DATABASE=1 SYNC_START_DATE=2026-09-01 node build/sync.js`

## EC2 主機重啟後初始指令
不用手動做。redis-server、mongod 與 pm2（`pm2-ubuntu.service`）都已經設成開機自動啟動，pm2 會照 `~/ecosystem.config.js` 用 Node 20 啟動這個後端。要手動重新登記時：
```
pm2 delete stock
pm2 start ~/ecosystem.config.js --only stock
pm2 save
```
