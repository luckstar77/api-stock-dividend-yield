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
- 上市 2004 年的除權息都查不到詳細資料，2005 年也有少數幾筆查不到；這些的配股數是用表格的息值與價格推算的，分不出同一天的現金增資。

## 流程
- `build/sync.js`（每天 18:30 由 systemd timer 執行，見 `deploy/`）
  - 讀取除權除息計算結果表，存進 `dividend_event`
  - 有配股的除權息，從詳細資料補上現金股利與配股數
  - 從上次停下的那天起，逐日讀取收盤價，標記已填權息的除權息
  - 算出每檔股票的統計，寫進 `stock`；最新一個交易日的上市、上櫃清單寫進 Redis 的 `STOCKS`
  - 第一次執行要讀 2004 年以後的每個交易日，大約要半天；每處理完一天就存進度，中斷了下次會接著做
- API（`build/index.js`）只讀資料庫，API 規格見下面「API」一節
  - `GET /v1/stocks/dividends?keyword=2330`：一檔股票的統計與逐年股利
  - `GET /v1/stocks`：搜尋框用的股票清單
  - `GET /v1/health`：MongoDB 與 Redis 是否正常
  - 舊版 `GET /stock?search=2330`、`GET /stocks` 照舊保留，等所有前端都改用 `/v1` 再移除

## 程式架構
```
src/
  index.ts                 啟動：連資料庫、建索引、組裝 service、listen
  app.ts                   createApp(deps)：Express 設定與路由掛載（測試時換成假的 repository）
  config.ts                PORT、快取秒數等設定
  http/response.ts         /v1 的回應格式 { status, code, data } 與回應碼
  routes/                  legacy-routes.ts（/stock、/stocks）、v1-routes.ts（/v1/*）
  services/stock-service.ts  商業邏輯：組出清單、統計與逐年股利
  repositories/            MongoDB（stock、dividend_event）與 Redis（STOCKS）的讀取
  dividend/                統計與逐年股利的純函式（summary.ts、history.ts）、sync 的規則
  sources/                 證交所與櫃買中心的資料讀取
  sync.ts                  每日更新（build/sync.js）
```

## API
`/v1` 的回應都是 `{ status, code, data?, error? }`。查無資料、輸入錯誤也回 HTTP 200，用 `code` 區分；只有伺服器錯誤回 HTTP 500。

| code | 意思 |
|------|------|
| 20000 | 成功 |
| 20400 | 查無資料 |
| 40000 | 輸入錯誤（例如沒有 keyword） |
| 40400 | 沒有這個路徑（HTTP 404） |
| 50000 | 伺服器錯誤（HTTP 500） |

成功的回應帶 `Cache-Control: public, max-age=600`（資料一天只更新一次），其他回應與 `/v1/health` 帶 `no-store`。

### `GET /v1/stocks/dividends?keyword=2330`
`keyword` 是股票代號或完整名稱。
```json
{
  "status": "ok",
  "code": 20000,
  "data": {
    "idString": "2330",
    "name": "台積電",
    "market": "twse",
    "successRatio": 100,
    "avgCashYieldRatio": 3.1555969257801637,
    "avgRetroactiveYieldRatio": 4.099856276335496,
    "dividendYearCount": 23,
    "filledYearCount": 23,
    "dividendYearStart": 2004,
    "dividendYearEnd": 2026,
    "dataThroughDate": "2026-11-25",
    "updatedAt": "2026-11-25T10:35:38.711Z",
    "lastClose": 1450,
    "lastCloseDate": "2026-11-25",
    "trailingCashDividend": 22,
    "trailingCashYieldRatio": 1.5172413793103448,
    "years": [
      {
        "year": 2026,
        "cashDividend": 17,
        "stockDividend": 0,
        "cashYieldRatio": 1.1492125454300715,
        "retroactiveYieldRatio": 1.1492125454300715,
        "isFilled": false,
        "events": [
          {
            "exDate": "2026-03-17",
            "kind": "cash",
            "preExClose": 1380,
            "referencePrice": 1375,
            "cashDividend": 5,
            "stockDividend": 0,
            "filledDate": "2026-03-24",
            "fillDayCount": 7,
            "isAmountEstimated": false
          }
        ]
      }
    ]
  }
}
```
- `market`：`twse` 上市、`tpex` 上櫃；以前從 goodinfo 抓、沒有除權息資料的股票是 `null`
- `successRatio`、`*YieldRatio` 是百分比（0–100），沒有四捨五入
- `lastClose`、`lastCloseDate`：最新一個交易日的收盤價；sync 寫進這兩個欄位之前是 `null`
- `trailingCashDividend`：`lastCloseDate`（沒有就用 `dataThroughDate`，再沒有就用今天）往前 365 天內除息的現金股利合計；`trailingCashYieldRatio` 是它除以 `lastClose`
- `years`：新的年份在前，一年內的除權息舊的在前。和統計一樣只算金額已知、而且真的有發股利的除權息（現金增資不算）
  - `stockDividend`：股票股利，以面額 10 元換算成元（每股配 0.1 股 = 1 元）
  - `isFilled`：這一年所有除權息都填了
  - `fillDayCount`：除權息日到填權息日的日曆天數，當天填就是 0，還沒填是 `null`
  - `isAmountEstimated`：詳細資料查不到，金額是用表格推算的

### `GET /v1/stocks`
```json
{ "status": "ok", "code": 20000, "data": { "list": [{ "idString": "0050", "name": "元大台灣50" }], "listDate": "2026-11-25" } }
```
依代號排序。sync 還沒跑過時回 `code: 20400`、`list: []`。

### `GET /v1/health`
```json
{ "status": "ok", "code": 20000, "data": { "mongodb": "up", "redis": "up" } }
```
任何一個 3 秒內沒回應就回 HTTP 500。

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
    - lastClose `double`：最新一個交易日（兩個市場都有開盤的那天）的收盤價；那天沒有收盤價的股票保留上次的值
    - lastCloseDate `string`：lastClose 是哪一天的
  - dividend_event：每檔股票的每次除權息與填權息日（API 用 `{ id: 1, date: 1 }` 索引查詢，啟動時會自動建立）
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
- 7 天以前的收盤價頁面讀不懂（例如日期對不上）：再問一次，還是不行就當成那個市場那天沒有收盤價，寫警告並記在 `sync_state.unreadableCloseDays`，不會卡在那天。同一個市場連續 3 天都讀不懂，比較像網站在回錯誤（例如限流），就把進度退回這幾天之前並停下，30 分鐘後重查。最近 7 天的讀不懂就直接停下，30 分鐘後重跑。
- 詳細資料明確回「無相關資料」或「查無相關資料」、表格也沒有息值可以推算的除權息，不算進統計，log 會列出。
- 較晚才公布、日期落在已經檢查過的日子的除權息，下次執行會從那天起重新檢查收盤價。
- Redis 或 MongoDB 連不上時 API 回 500，不會讓請求一直等。`/v1/health` 另外有 3 秒的上限，資料庫卡住不回應也會回 500。

## CI/CD
GitHub Actions（`.github/workflows/ci.yml`）：

- 每個 PR 與 master 的 push：Node 20 上跑 `npm ci`、`npm run lint`、`npm test`
- master 的 push（或手動執行 workflow）在測試通過後部署：用 SSH 連到 EC2 執行 `deploy/deploy.sh`
  - fast-forward 到這次的 commit（主機上的 checkout 有改動或分岔就停下，不會蓋掉）
  - `npm ci`、`npm test`、`pm2 restart stock`，等 `GET /v1/health` 回 OK
  - 中途失敗就退回上一個 commit、重新 build 並重啟
- 沒設定下面的 secrets 時，部署步驟會略過（job 顯示 notice，不會失敗）

GitHub repo 的 Settings → Secrets and variables → Actions 要設定：

| Secret | 內容 |
|--------|------|
| `EC2_HOST` | 主機位址，例如 `api.stock.imallenlai.com` 或 IP |
| `EC2_USER` | SSH 使用者，例如 `ubuntu` |
| `EC2_SSH_KEY` | 部署用的 SSH 私鑰（整份內容） |
| `EC2_APP_DIR` | 選填，主機上的專案路徑，預設 `~/stock-dividend-yield/api-stock-dividend-yield` |
| `EC2_HOST_KEY` | 選填，主機在 `known_hosts` 的那一行；沒設定就用 `ssh-keyscan` 取得 |

主機只要設定一次：

1. 產生部署專用的金鑰：`ssh-keygen -t ed25519 -f stock-deploy -C github-actions -N ''`，把 `stock-deploy.pub` 加進主機的 `~/.ssh/authorized_keys`，`stock-deploy` 的內容存成 `EC2_SSH_KEY`
2. EC2 的 security group 要允許 GitHub Actions 連 SSH（22 埠）。只開放自己 IP 的話，改用 self-hosted runner 或 AWS SSM
3. 主機上的專案要在 master、沒有未 commit 的改動，`git fetch` 不需要輸入帳密（這個 repo 是 public）

手動部署：
```
nvm use 20
git pull
npm ci
npm test
pm2 restart stock
```

## 部署
主機上用 Node.js 20（主機預設是 Node 18）。平常由 CI 部署，見上一節。
- `PORT`：監聽的埠，預設 3000
- `MONGODB_URL`、`REDIS_URL`：選填，預設連本機的 MongoDB 與 Redis
- 每日更新的 systemd 設定在 `deploy/`，安裝方式寫在 `deploy/stock-dividend-sync.service` 的開頭。看進度：`journalctl -u stock-dividend-sync -f`
- 試跑時不要寫進正式的資料：`MONGODB_DB_NAME=inventory_trial REDIS_DATABASE=1 SYNC_START_DATE=2026-09-01 node build/sync.js`

## EC2 主機重啟後初始指令
不用手動做。redis-server、mongod 與 pm2（`pm2-ubuntu.service`）都已經設成開機自動啟動，pm2 會照 `~/ecosystem.config.js` 用 Node 20 啟動這個後端。要手動重新登記時：
```
pm2 delete stock
pm2 start ~/ecosystem.config.js --only stock
pm2 save
```
