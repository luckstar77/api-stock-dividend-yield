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
- 取得GOODINFO網站的股票ID資訊 <https://goodinfo.tw/tw/StockLib/js/TW_STOCK_ID_NM_LIST.js?0>  
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

## EC2 主機重啟後初始指令
```
sudo systemctl start redis-server
sudo systemctl start mongod
cd stock-dividend-yield/api-stock-dividend-yield
pm2 start build/index.js
```