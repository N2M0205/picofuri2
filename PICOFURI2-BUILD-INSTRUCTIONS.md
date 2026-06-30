# PICOFURI2 構築指示書
> Claude Code 実行用 / Linux VPS（Ubuntu 24.04）ゼロから構築

---

## このファイルについて

このファイルはClaude Codeが読み込んで実行するための完全自己完結型の構築指示書です。
Linux VPS上に`~/picofuri2/`を新規作成し、フリマ監視システムをゼロから構築します。

**既存プロジェクトは存在しません。このファイルの指示だけで完結させてください。**

---

## システム概要

| 項目 | 内容 |
|------|------|
| プロジェクト名 | picofuri2 |
| 設置場所 | ~/picofuri2/ |
| 目的 | メルカリ・Yahoo!フリマの自社商品転売監視・LINE通知 |
| メルカリ方式 | 内部API直叩き（Puppeteer不使用） |
| Yahoo方式 | Puppeteer + StealthPlugin |
| 通知先 | LINE Messaging API（broadcast） |
| DB | SQLite（Sequelize経由） |
| スキャン間隔 | 60秒ごと |
| CROSSMALL連携 | 2時間ごと同期・利益計算に使用 |

---

## 作業ルール（厳守）

1. ファイルを1つ作るたびに動作確認してから次に進む
2. エラーが出たら「原因・影響・修正案」をセットで報告する
3. .envの秘密情報（APIキー等）をログやコードに直接書かない
4. 複数の変更を一気に入れない（問題の切り分けが困難になる）
5. 各ステップ完了時にサマリを報告する

---

## STEP 0：環境確認とNode.jsインストール

```bash
node --version
npm --version
```

Node.jsが入っていない場合、以下でnvmをインストールしてNode.js v22を導入する：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node --version  # v22.x.x が表示されればOK
```

---

## STEP 1：プロジェクト作成とパッケージインストール

```bash
cd ~
mkdir picofuri2
cd picofuri2
npm init -y
```

必要パッケージをインストール：

```bash
npm install axios jose uuid node-cron sequelize sqlite3 \
  puppeteer puppeteer-extra puppeteer-extra-plugin-stealth \
  dotenv express
```

pm2をグローバルインストール：

```bash
npm install -g pm2
```

ディレクトリ構成を作成：

```bash
mkdir -p src/scrapers src/services src/models logs
```

**確認：** `ls src/` で scrapers/ services/ models/ が存在すること。

---

## STEP 2：.envファイル作成

`.env`を作成する。**PowerShellではなくLinuxのechoコマンドで作成すること（BOM問題回避）。**

```bash
cat > ~/picofuri2/.env << 'EOF'
NODE_ENV=development
PORT=3001

# スクレイピング設定
SCRAPING_INTERVAL_SECONDS=60
SCRAPING_CONCURRENCY_MERCARI=3
SCRAPING_CONCURRENCY_YAHOO=2

# LINE Messaging API
LINE_NOTIFY_ENABLED=true
LINE_CHANNEL_ACCESS_TOKEN=REPLACE_ME
LINE_CHANNEL_SECRET=REPLACE_ME

# CROSSMALL API
CROSSMALL_API_URL=https://crossmall.jp/webapi2
CROSSMALL_ACCOUNT=3663
CROSSMALL_API_KEY=REPLACE_ME

# Telegram Bot
TELEGRAM_BOT_TOKEN=REPLACE_ME
TELEGRAM_ADMIN_ID=8656466812
EOF
```

**重要：** `REPLACE_ME` の箇所はオーナーが別途記入する。このファイルに実際のAPIキーは書かないこと。

---

## STEP 3：DBモデル作成

### src/models/index.js

```javascript
const { Sequelize, DataTypes } = require('sequelize');
const path = require('path');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, '../../database.sqlite'),
  logging: false,
  pool: { max: 1 },
  retry: { max: 5 }
});

// SQLITE_BUSY対策（既知の教訓: WALモード + busy_timeoutが必須）
sequelize.query('PRAGMA journal_mode = WAL;');
sequelize.query('PRAGMA busy_timeout = 5000;');

// キーワードテーブル
const Keyword = sequelize.define('Keyword', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  keyword: { type: DataTypes.STRING, allowNull: false },
  platforms: {
    type: DataTypes.TEXT,
    get() { return JSON.parse(this.getDataValue('platforms') || '[]'); },
    set(v) { this.setDataValue('platforms', JSON.stringify(v)); }
  },
  excludeKeywords: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    get() { return JSON.parse(this.getDataValue('excludeKeywords') || '[]'); },
    set(v) { this.setDataValue('excludeKeywords', JSON.stringify(v)); }
  },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

// 検出済み商品テーブル
const DetectedItem = sequelize.define('DetectedItem', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  itemId: { type: DataTypes.STRING, allowNull: false, unique: true },
  platform: { type: DataTypes.STRING, allowNull: false },
  title: { type: DataTypes.STRING },
  price: { type: DataTypes.INTEGER },
  imageUrl: { type: DataTypes.TEXT },
  itemUrl: { type: DataTypes.TEXT },
  listedAt: { type: DataTypes.DATE },
  keywordId: { type: DataTypes.INTEGER },
  notified: { type: DataTypes.BOOLEAN, defaultValue: false },
  notifiedAt: { type: DataTypes.DATE }
});

// CROSSMALL商品マスタテーブル
const CrossmallProduct = sequelize.define('CrossmallProduct', {
  itemCode: { type: DataTypes.STRING, primaryKey: true },
  itemName: { type: DataTypes.STRING },
  stock: { type: DataTypes.INTEGER, defaultValue: 0 },
  purchasePrice: { type: DataTypes.INTEGER, defaultValue: 0 },
  retailPrice: { type: DataTypes.INTEGER, defaultValue: 0 },
  sales7: { type: DataTypes.INTEGER, defaultValue: 0 },
  sales14: { type: DataTypes.INTEGER, defaultValue: 0 },
  sales28: { type: DataTypes.INTEGER, defaultValue: 0 },
  lastSyncedAt: { type: DataTypes.DATE }
}, { timestamps: true });

// 初期キーワードデータ
const INITIAL_KEYWORDS = [
  { keyword: 'トイラボ',              platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'ToyLaBO',              platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'オキシカット',          platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'risou no Coffee 30',   platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'レムウェル 180',        platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'WiQo',                 platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'ラクトフェリン 93',     platforms: ['mercari'] },
  { keyword: '尿酸と脂肪のダブルバスター', platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'アスハダ 30ml',        platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'ホルモ プレミアム',     platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'アルマダ 1000ml',      platforms: ['mercari', 'yahoo_flea'] },
  { keyword: '野草酵素',             platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'デイリーワン',         platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'デオエース 40ml',      platforms: ['yahoo_flea'] },
  { keyword: 'ワンデイ クレンズ',    platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'SENOPPY CHEWABLE',    platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'セノッピー チュアブル', platforms: ['mercari', 'yahoo_flea'] },
  { keyword: '養宝珠 90粒',         platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'ホワイトハンドセラム 20ml', platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'ルックルック イヌリンプラス', platforms: ['mercari', 'yahoo_flea'] },
  { keyword: 'りそうのコーヒー',     platforms: ['mercari'] },
];

async function initDB() {
  await sequelize.sync({ alter: true });
  const count = await Keyword.count();
  if (count === 0) {
    await Keyword.bulkCreate(INITIAL_KEYWORDS);
    console.log(`[DB] ${INITIAL_KEYWORDS.length}件のキーワードを初期登録しました`);
  }
  console.log('[DB] 初期化完了');
}

module.exports = { sequelize, Keyword, DetectedItem, CrossmallProduct, initDB };
```

**テスト：**

```bash
node -e "require('./src/models/index.js').initDB().then(() => console.log('OK'))"
```

`database.sqlite`が生成され「初期化完了」が表示されればOK。

---

## STEP 4：MercariApiScraper作成

### src/scrapers/MercariApiScraper.js

メルカリ内部APIを直接叩く。Chromeプロセスを一切使わない。

**技術背景（重要）：**
- メルカリWebサイトはNext.js SPAで内部的にREST APIを叩いている
- エンドポイント: `POST https://api.mercari.jp/v2/entities:search`
- 認証: DPoP（Demonstration of Proof-of-Possession）トークンが必要
- DPoPはEC P-256鍵ペアで署名したJWTで、リクエストごとに生成する
- ログインなしで動作する（authorizationヘッダー不要）
- レスポンスの`created`フィールドにUnixタイムスタンプで出品日時が入る

```javascript
const { SignJWT, generateKeyPair, exportJWK } = require('jose');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

class MercariApiScraper {
  constructor() {
    this.keyPair = null;
    this.publicKeyJwk = null;
    this.initialized = false;
  }

  // 起動時に1回だけ呼ぶ
  async initialize() {
    this.keyPair = await generateKeyPair('ES256');
    this.publicKeyJwk = await exportJWK(this.keyPair.publicKey);
    this.initialized = true;
    console.log('[MercariApiScraper] 初期化完了（DPoP鍵ペア生成済み）');
  }

  // リクエストごとに新しいDPoPトークンを生成
  async _generateDPoP(deviceUuid) {
    return await new SignJWT({
      iat: Math.floor(Date.now() / 1000),
      jti: uuidv4(),
      htu: 'https://api.mercari.jp/v2/entities:search',
      htm: 'POST',
      uuid: deviceUuid
    })
    .setProtectedHeader({
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: this.publicKeyJwk
    })
    .sign(this.keyPair.privateKey);
  }

  async search(keyword) {
    if (!this.initialized) throw new Error('initialize()を先に呼んでください');

    const deviceUuid = uuidv4();
    const searchSessionId = uuidv4().replace(/-/g, '');
    const dpop = await this._generateDPoP(deviceUuid);

    const payload = {
      userId: "",
      config: { responseToggles: ["QUERY_SUGGESTION_WEB_1"] },
      pageSize: 120,
      pageToken: "",
      searchCondition: {
        keyword: keyword,
        excludeKeyword: "",
        sort: "SORT_CREATED_TIME",  // 新着順
        order: "ORDER_DESC",
        status: ["on_sale"],         // 販売中のみ
        sizeId: [], categoryId: [], brandId: [],
        sellerId: [], priceMin: 0, priceMax: 0,
        itemConditionId: [], shippingPayerId: []
      },
      searchSessionId: searchSessionId,
      laplaceDeviceUuid: deviceUuid,
      serviceFrom: "suruga",
      source: "BaseSerp",
      thumbnailTypes: [],
      useDynamicAttribute: true,
      withAuction: true,
      withItemBrand: true,
      withItemPromotions: true,
      withItemSize: false,
      withItemSizes: true,
      withOfferPricePromotion: true,
      withParentProducts: false,
      withProductArticles: true,
      withProductSuggest: true,
      withSearchConditionId: false,
      withShopname: false,
      withSuggestedItems: true,
      indexRouting: "INDEX_ROUTING_UNSPECIFIED"
    };

    try {
      const response = await axios.post(
        'https://api.mercari.jp/v2/entities:search',
        payload,
        {
          headers: {
            'content-type': 'application/json',
            'dpop': dpop,
            'x-platform': 'web',
            'x-country-code': 'JP',
            'origin': 'https://jp.mercari.com',
            'referer': 'https://jp.mercari.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'ja',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'cross-site'
          },
          timeout: 10000
        }
      );

      const items = response.data.items || [];

      return items.map(item => ({
        id: item.id,
        title: item.name,
        price: parseInt(item.price) || 0,
        imageUrl: item.thumbnails?.[0] || '',
        itemUrl: `https://jp.mercari.com/item/${item.id}`,
        listedAt: item.created
          ? new Date(parseInt(item.created) * 1000)
          : null,
        status: item.status,
        platform: 'mercari'
      }));

    } catch (err) {
      const status = err.response?.status;
      console.error(`[MercariApiScraper] "${keyword}" エラー: ${status || err.message}`);
      // 429（レート制限）の場合は少し待つ
      if (status === 429) {
        await new Promise(r => setTimeout(r, 5000));
      }
      return [];
    }
  }
}

module.exports = MercariApiScraper;
```

**テスト：**

```bash
node -e "
const MercariApiScraper = require('./src/scrapers/MercariApiScraper.js');
const s = new MercariApiScraper();
s.initialize().then(() =>
  s.search('オキシカット').then(items => {
    console.log('取得件数:', items.length);
    if (items.length > 0) {
      console.log('最新商品:', JSON.stringify(items[0], null, 2));
    }
  })
);
"
```

**確認ポイント：**
- 取得件数が0より大きい
- `listedAt`がnullでなくDateオブジェクトになっている
- `itemUrl`が正しい形式

取得件数が0の場合はsortを`SORT_SCORE`に変えて再テストし、原因を報告すること。

---

## STEP 5：YahooScraper作成

### src/scrapers/YahooScraper.js

Yahoo!フリマをPuppeteer+StealthPluginでスクレイピング。

```javascript
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

puppeteer.use(StealthPlugin());

class YahooScraper {

  async search(keyword) {
    const userDataDir = path.join(os.tmpdir(), `pf2_yahoo_${Date.now()}_${uuidv4().slice(0,8)}`);
    let browser = null;

    try {
      browser = await puppeteer.launch({
        headless: 'new',
        userDataDir: userDataDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process'
        ],
        protocolTimeout: 90000
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
      );

      const searchUrl = `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(keyword)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 商品リストの描画を待つ（セレクタは実際のYahoo!フリマのDOMに合わせて調整）
      try {
        await page.waitForSelector('a[href*="/item/"]', { timeout: 15000 });
      } catch {
        console.warn(`[YahooScraper] "${keyword}": 商品セレクタのタイムアウト`);
        return [];
      }

      await new Promise(r => setTimeout(r, 1500));

      const items = await page.evaluate(() => {
        const results = [];
        // 商品リンクを取得（Yahoo!フリマのURL形式: /item/[id]）
        const links = document.querySelectorAll('a[href*="/item/"]');
        const seen = new Set();

        links.forEach(link => {
          const href = link.href;
          const match = href.match(/\/item\/([a-zA-Z0-9]+)/);
          if (!match || seen.has(match[1])) return;
          seen.add(match[1]);

          // 価格テキストを取得（数字のみ抽出）
          const priceEl = link.querySelector('[class*="price"], [class*="Price"]');
          const priceText = priceEl?.textContent || '';
          const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;

          // タイトルを取得
          const titleEl = link.querySelector('img');
          const title = titleEl?.alt || link.getAttribute('aria-label') || '';

          // 画像URL
          const imgUrl = titleEl?.src || '';

          if (match[1] && price > 0) {
            results.push({
              id: match[1],
              title: title,
              price: price,
              imageUrl: imgUrl,
              itemUrl: href
            });
          }
        });

        return results;
      });

      return items.map(item => ({
        ...item,
        listedAt: null,   // Yahoo!フリマはタイムスタンプ取得不可
        platform: 'yahoo_flea'
      }));

    } catch (err) {
      console.error(`[YahooScraper] "${keyword}" エラー: ${err.message}`);
      return [];

    } finally {
      if (browser) {
        try {
          await Promise.race([
            browser.close(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
          ]);
        } catch {
          try {
            const pid = browser.process()?.pid;
            if (pid) process.kill(pid, 'SIGKILL');
          } catch {}
        }
      }
      // 一時プロファイル削除
      try {
        if (fs.existsSync(userDataDir)) {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}

module.exports = YahooScraper;
```

**テスト：**

```bash
node -e "
const YahooScraper = require('./src/scrapers/YahooScraper.js');
const s = new YahooScraper();
s.search('オキシカット').then(items => {
  console.log('取得件数:', items.length);
  if (items.length > 0) console.log('最初の商品:', items[0]);
});
"
```

**確認ポイント：**
- 取得件数が0より大きい
- `price`が数値で入っている
- `itemUrl`がYahoo!フリマのURL形式

取得件数が0の場合、page.evaluate内のセレクタを調整する。
実際のYahoo!フリマのHTMLを `page.content()` で確認して正しいセレクタを特定すること。

---

## STEP 6：CrossmallService作成

### src/services/CrossmallService.js

CROSSMALL APIと連携して在庫・売上・商品名を取得する。

**CROSSMALL API仕様（重要）：**
- ベースURL: `https://crossmall.jp/webapi2`
- 全リクエストにMD5署名が必要
- 署名生成: api_keyを除くパラメータをキー名でソート → `key=value&...` → 末尾に生のAPIキー値を結合 → MD5 → 小文字16進数（api_keyはパラメータとしては送信しない）
- `order_number`パラメータのみでページネーション可能（conditionは不要）
- `get_stock`は商品名を返さない。商品名は`get_item`で取得する

```javascript
const axios = require('axios');
const crypto = require('crypto');
const { CrossmallProduct } = require('../models/index.js');

class CrossmallService {
  constructor() {
    this.apiUrl = process.env.CROSSMALL_API_URL;
    this.account = process.env.CROSSMALL_ACCOUNT;
    this.apiKey = process.env.CROSSMALL_API_KEY;
  }

  // MD5署名生成（CROSSMALL社の正式仕様）
  // 手順: api_keyを含まないパラメータをkey名でソート→"key=value&..."→末尾に生のAPIキー値を結合→MD5→小文字16進数
  // ※api_keyはリクエストパラメータとしても一切送信しない（署名計算にのみ使う）
  _generateSigning(params) {
    const sorted = Object.keys(params)
      .sort()
      .map(k => `${k}=${encodeURIComponent(params[k])}`)
      .join('&');
    return crypto.createHash('md5').update(sorted + this.apiKey).digest('hex');
  }

  // APIリクエスト共通メソッド
  async _request(endpoint, params) {
    const allParams = {
      account: this.account,
      ...params
    };
    const signing = this._generateSigning(allParams);

    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${this.apiUrl}/${endpoint}?${queryString}&signing=${signing}`;

    try {
      const response = await axios.get(url, {
        timeout: 30000,
        responseType: 'text'
      });

      // XMLレスポンスをパース
      const xml = response.data;
      return xml;
    } catch (err) {
      console.error(`[CrossmallService] ${endpoint} エラー: ${err.message}`);
      throw err;
    }
  }

  // XMLから簡易パース（正規表現ベース）
  _parseXml(xml, tagName) {
    const results = [];
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 'gs');
    let match;
    while ((match = regex.exec(xml)) !== null) {
      results.push(match[1]);
    }
    return results;
  }

  _parseXmlTag(block, tagName) {
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 's');
    const match = block.match(regex);
    return match ? match[1].trim() : '';
  }

  // 在庫取得（get_stock）
  async getStock() {
    console.log('[CrossmallService] 在庫データ取得中...');
    const xml = await this._request('get_stock', {
      condition: 'all'
    });

    const items = this._parseXml(xml, 'item');
    const result = {};
    items.forEach(item => {
      const code = this._parseXmlTag(item, 'item_code');
      const stock = parseInt(this._parseXmlTag(item, 'quantity')) || 0;
      if (code) result[code] = stock;
    });

    console.log(`[CrossmallService] 在庫取得: ${Object.keys(result).length}件`);
    return result;
  }

  // 売上取得（get_order, 最新100件）
  async getRecentOrders() {
    console.log('[CrossmallService] 売上データ取得中...');
    const xml = await this._request('get_order', {
      order_number: '1'
    });

    const orders = this._parseXml(xml, 'order');
    const salesByCode = {};

    const now = Date.now();
    const day7  = now - 7  * 24 * 3600 * 1000;
    const day14 = now - 14 * 24 * 3600 * 1000;
    const day28 = now - 28 * 24 * 3600 * 1000;

    orders.forEach(order => {
      const dateStr = this._parseXmlTag(order, 'order_date');
      const orderTime = new Date(dateStr).getTime();
      const details = this._parseXml(order, 'detail');

      details.forEach(detail => {
        const code = this._parseXmlTag(detail, 'item_code');
        const qty  = parseInt(this._parseXmlTag(detail, 'quantity')) || 0;
        if (!code) return;

        if (!salesByCode[code]) salesByCode[code] = { s7: 0, s14: 0, s28: 0 };
        if (orderTime >= day28) salesByCode[code].s28 += qty;
        if (orderTime >= day14) salesByCode[code].s14 += qty;
        if (orderTime >= day7)  salesByCode[code].s7  += qty;
      });
    });

    return salesByCode;
  }

  // 商品情報取得（get_item）- 商品名・価格取得用
  async getItemInfo(itemCodes) {
    const result = {};
    // 10件ずつ取得
    for (let i = 0; i < itemCodes.length; i += 10) {
      const batch = itemCodes.slice(i, i + 10);
      for (const code of batch) {
        try {
          const xml = await this._request('get_item', { item_code: code });
          const name = this._parseXmlTag(xml, 'item_name');
          const price = parseInt(this._parseXmlTag(xml, 'cost_price')) || 0;
          const retail = parseInt(this._parseXmlTag(xml, 'fixed_price')) || 0;
          result[code] = { name, purchasePrice: price, retailPrice: retail };
          await new Promise(r => setTimeout(r, 200)); // 過負荷防止
        } catch {
          // 個別エラーはスキップ
        }
      }
    }
    return result;
  }

  // DB同期（全データを更新）
  async syncAll() {
    console.log('[CrossmallService] 同期開始...');
    try {
      const stocks = await this.getStock();
      const sales = await this.getRecentOrders();
      const itemCodes = Object.keys(stocks);

      // 商品情報取得（DB未登録のもののみ）
      const existingCodes = (await CrossmallProduct.findAll({
        attributes: ['itemCode']
      })).map(r => r.itemCode);
      const newCodes = itemCodes.filter(c => !existingCodes.includes(c));
      const itemInfos = newCodes.length > 0 ? await this.getItemInfo(newCodes) : {};

      // upsert
      for (const code of itemCodes) {
        const s = sales[code] || { s7: 0, s14: 0, s28: 0 };
        const info = itemInfos[code] || {};
        await CrossmallProduct.upsert({
          itemCode: code,
          stock: stocks[code],
          sales7: s.s7, sales14: s.s14, sales28: s.s28,
          ...(info.name && { itemName: info.name }),
          ...(info.purchasePrice && { purchasePrice: info.purchasePrice }),
          ...(info.retailPrice && { retailPrice: info.retailPrice }),
          lastSyncedAt: new Date()
        });
      }

      console.log(`[CrossmallService] 同期完了: ${itemCodes.length}件`);
    } catch (err) {
      console.error('[CrossmallService] 同期エラー:', err.message);
    }
  }

  // キーワードに対応する商品コードを検索（商品名で部分一致）
  async findProductByKeyword(keyword) {
    const products = await CrossmallProduct.findAll();
    return products.find(p =>
      p.itemName && p.itemName.includes(keyword)
    ) || null;
  }

  // 利益計算
  calcProfit(listedPrice, purchasePrice) {
    if (!purchasePrice || purchasePrice <= 0) return null;
    const commission = Math.floor(listedPrice * 0.1); // メルカリ手数料10%
    const profit = listedPrice - commission - purchasePrice;
    const margin = Math.round((profit / listedPrice) * 100);
    return { profit, margin, commission, purchasePrice };
  }
}

module.exports = CrossmallService;
```

**テスト（APIキー設定後）：**

```bash
node -e "
require('dotenv').config();
const CrossmallService = require('./src/services/CrossmallService.js');
const { initDB } = require('./src/models/index.js');
initDB().then(async () => {
  const s = new CrossmallService();
  const stocks = await s.getStock();
  console.log('在庫件数:', Object.keys(stocks).length);
  console.log('サンプル:', Object.entries(stocks).slice(0,3));
});
"
```

---

## STEP 7：NotificationService作成

### src/services/NotificationService.js

LINE Messaging APIでbroadcast送信する。

```javascript
const axios = require('axios');

class NotificationService {
  constructor() {
    this.token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    this.enabled = process.env.LINE_NOTIFY_ENABLED === 'true';
  }

  // LINE broadcast送信
  async sendLine(message) {
    if (!this.enabled) {
      console.log('[LINE] 送信無効（LINE_NOTIFY_ENABLED=false）');
      return;
    }
    if (!this.token || this.token === 'REPLACE_ME') {
      console.warn('[LINE] トークン未設定');
      return;
    }

    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/broadcast',
        {
          messages: [{ type: 'text', text: message }]
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      console.log('[LINE] 送信成功');
    } catch (err) {
      console.error('[LINE] 送信エラー:', err.response?.status, err.message);
    }
  }

  // 新着商品の通知メッセージ生成
  buildNewItemMessage(item, keyword, profitInfo) {
    const platform = item.platform === 'mercari' ? 'メルカリ' : 'Yahoo!フリマ';
    const priceStr = `¥${item.price.toLocaleString()}`;
    const dateStr = item.listedAt
      ? item.listedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : '不明';

    let msg = [
      `🆕 新着出品【${platform}】`,
      `━━━━━━━━━━━`,
      `商品名: ${item.title}`,
      `価格: ${priceStr}`,
      `出品日時: ${dateStr}`,
      `キーワード: ${keyword}`
    ].join('\n');

    if (profitInfo) {
      const profitStr = profitInfo.profit >= 0
        ? `+¥${profitInfo.profit.toLocaleString()}`
        : `-¥${Math.abs(profitInfo.profit).toLocaleString()}`;
      msg += [
        '',
        '💰 利益試算',
        `仕入: ¥${profitInfo.purchasePrice.toLocaleString()}`,
        `手数料: ¥${profitInfo.commission.toLocaleString()}`,
        `利益: ${profitStr}（${profitInfo.margin}%）`
      ].join('\n');
    }

    msg += `\n\n🔗 ${item.itemUrl}`;
    return msg;
  }

  // 通知送信（新着商品）
  async notifyNewItem(item, keyword, profitInfo) {
    const message = this.buildNewItemMessage(item, keyword, profitInfo);
    console.log(`[通知] ${item.platform} "${item.title}" ¥${item.price}`);
    await this.sendLine(message);
  }
}

module.exports = NotificationService;
```

---

## STEP 8：ScrapingService作成

### src/services/ScrapingService.js

スクレイピングの統括サービス。

```javascript
const { Keyword, DetectedItem } = require('../models/index.js');
const MercariApiScraper = require('../scrapers/MercariApiScraper.js');
const YahooScraper = require('../scrapers/YahooScraper.js');
const CrossmallService = require('./CrossmallService.js');
const NotificationService = require('./NotificationService.js');

class ScrapingService {
  constructor() {
    this.mercariScraper = new MercariApiScraper();
    this.yahooScraper = new YahooScraper();
    this.crossmall = new CrossmallService();
    this.notification = new NotificationService();
    this.isRunning = false;
    this.lastRunAt = null;
    this.stats = { success: 0, error: 0, notified: 0 };
  }

  async initialize() {
    await this.mercariScraper.initialize();
    console.log('[ScrapingService] 初期化完了');
  }

  // 並列実行ヘルパー（concurrency数に制限）
  async _runWithConcurrency(tasks, concurrency) {
    const results = [];
    const queue = [...tasks];

    async function worker() {
      while (queue.length > 0) {
        const task = queue.shift();
        const result = await task();
        results.push(result);
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    return results;
  }

  // グローバル除外キーワード
  _isExcluded(title, excludeKeywords) {
    const GLOBAL_EXCLUDE = ['まとめ', 'まとめ売り', 'セット', 'ジャンク', '偽物', 'レプリカ', '空箱', 'サンプル'];
    const allExcludes = [...GLOBAL_EXCLUDE, ...excludeKeywords];
    return allExcludes.some(ex => title.includes(ex));
  }

  // 1スキャン実行
  async runScan() {
    if (this.isRunning) {
      console.log('[ScrapingService] 前回スキャン実行中のためスキップ');
      return;
    }
    this.isRunning = true;
    const startTime = Date.now();
    console.log(`[ScrapingService] スキャン開始: ${new Date().toLocaleString('ja-JP')}`);

    try {
      const keywords = await Keyword.findAll({ where: { isActive: true } });
      const mercariKeywords = keywords.filter(k => k.platforms.includes('mercari'));
      const yahooKeywords   = keywords.filter(k => k.platforms.includes('yahoo_flea'));

      const concMercari = parseInt(process.env.SCRAPING_CONCURRENCY_MERCARI) || 3;
      const concYahoo   = parseInt(process.env.SCRAPING_CONCURRENCY_YAHOO)   || 2;

      // メルカリスキャン
      const mercariTasks = mercariKeywords.map(kw => async () => {
        const items = await this.mercariScraper.search(kw.keyword);
        await this._processItems(items, kw);
        return items.length;
      });

      // Yahoo!フリマスキャン
      const yahooTasks = yahooKeywords.map(kw => async () => {
        const items = await this.yahooScraper.search(kw.keyword);
        await this._processItems(items, kw);
        return items.length;
      });

      await Promise.all([
        this._runWithConcurrency(mercariTasks, concMercari),
        this._runWithConcurrency(yahooTasks, concYahoo)
      ]);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[ScrapingService] スキャン完了: ${elapsed}秒 / 通知: ${this.stats.notified}件`);
      this.lastRunAt = new Date();

    } catch (err) {
      console.error('[ScrapingService] スキャンエラー:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  // 商品リストを処理（新着判定・通知）
  async _processItems(items, keyword) {
    for (const item of items) {
      // 除外キーワードチェック
      if (this._isExcluded(item.title, keyword.excludeKeywords || [])) continue;

      // DB照合（重複チェック）— findOrCreate()はSQLITE_BUSYの既知原因のため使わない
      let detected = await DetectedItem.findOne({ where: { itemId: item.id } });
      let created = false;
      if (!detected) {
        try {
          detected = await DetectedItem.create({
            itemId: item.id,
            platform: item.platform,
            title: item.title,
            price: item.price,
            imageUrl: item.imageUrl,
            itemUrl: item.itemUrl,
            listedAt: item.listedAt,
            keywordId: keyword.id,
            notified: false
          });
          created = true;
        } catch (err) {
          if (err.name === 'SequelizeUniqueConstraintError') {
            detected = await DetectedItem.findOne({ where: { itemId: item.id } });
            created = false;
          } else {
            throw err;
          }
        }
      }

      // 新着かつ未通知のみ通知
      if (created && !detected.notified) {
        // CROSSMALL利益情報を取得
        let profitInfo = null;
        try {
          const product = await this.crossmall.findProductByKeyword(keyword.keyword);
          if (product && product.purchasePrice > 0) {
            profitInfo = this.crossmall.calcProfit(item.price, product.purchasePrice);
          }
        } catch {}

        await this.notification.notifyNewItem(item, keyword.keyword, profitInfo);

        await detected.update({ notified: true, notifiedAt: new Date() });
        this.stats.notified++;
      }
    }
  }
}

module.exports = ScrapingService;
```

---

## STEP 9：エントリーポイント作成

### src/index.js

```javascript
require('dotenv').config();
const cron = require('node-cron');
const express = require('express');
const { initDB } = require('./models/index.js');
const ScrapingService = require('./services/ScrapingService.js');
const CrossmallService = require('./services/CrossmallService.js');

async function main() {
  console.log('=== ピコフリ2 起動中 ===');

  // DB初期化
  await initDB();

  // サービス初期化
  const scraping = new ScrapingService();
  await scraping.initialize();

  const crossmall = new CrossmallService();

  // スキャン間隔設定
  const intervalSec = parseInt(process.env.SCRAPING_INTERVAL_SECONDS) || 60;
  console.log(`[Scheduler] スキャン間隔: ${intervalSec}秒`);

  // 起動時に即1回スキャン
  setTimeout(() => scraping.runScan(), 5000);

  // 定期スキャン（node-cron: 最小1分間隔）
  // 60秒以下にしたい場合はsetIntervalを使う
  if (intervalSec < 60) {
    setInterval(() => scraping.runScan(), intervalSec * 1000);
  } else {
    cron.schedule(`*/${Math.floor(intervalSec / 60)} * * * *`, () => scraping.runScan());
  }

  // CROSSMALL同期（2時間ごと）
  cron.schedule('0 */2 * * *', () => crossmall.syncAll());

  // ステータスAPI（簡易）
  const app = express();
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      lastRunAt: scraping.lastRunAt,
      stats: scraping.stats,
      uptime: process.uptime()
    });
  });

  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log(`[API] http://localhost:${port}/health`));

  console.log('=== ピコフリ2 起動完了 ===');
}

main().catch(err => {
  console.error('起動エラー:', err);
  process.exit(1);
});
```

---

## STEP 10：PM2設定ファイル作成

### ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'picofuri2',
    script: './src/index.js',
    cwd: '/root/picofuri2',
    env: { NODE_ENV: 'development' },
    max_memory_restart: '400M',
    restart_delay: 5000,
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
```

---

## STEP 11：動作確認とPM2起動

### 統合テスト（PM2起動前に必ず実施）

```bash
cd ~/picofuri2
node src/index.js
```

ログに以下が出ることを確認：
- `[DB] 初期化完了`
- `[MercariApiScraper] 初期化完了`
- `[ScrapingService] スキャン開始`
- エラーなし

5分間動かして正常動作を確認してから Ctrl+C で停止。

### PM2起動

```bash
cd ~/picofuri2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # OS再起動時の自動起動設定
```

### 動作確認

```bash
pm2 status
pm2 logs picofuri2 --lines 50
curl http://localhost:3001/health
```

---

## STEP 12：Git初期化

```bash
cd ~/picofuri2
cat > .gitignore << 'EOF'
node_modules/
.env
database.sqlite
logs/
*.log
EOF

git init
git add .
git commit -m "feat: picofuri2 初期構築完了"
```

GitHubにpushする場合はオーナーの指示を待つ。

---

## 完了報告フォーマット

全ステップ完了後、以下の形式でサマリを報告すること：

| 項目 | 内容 |
|------|------|
| 作成ファイル数 | |
| DBレコード数（Keyword） | |
| メルカリAPIテスト結果 | 取得XX件 |
| Yahooスクレイピングテスト結果 | 取得XX件 |
| PM2状態 | |
| 懸念事項・未解決事項 | |

---

## 備考：CROSSMALL IPアドレス登録について

LinuxVPSのIPアドレスをCROSSMALL管理画面でAPIアクセス許可リストに追加する必要があります。
以下のコマンドでIPを確認してオーナーに報告してください：

```bash
curl ifconfig.me
```

CROSSMALL側の設定完了後に `src/services/CrossmallService.js` のテストを実施してください。
