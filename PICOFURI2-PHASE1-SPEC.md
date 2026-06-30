# PICOFURI2 Phase 1 実装仕様書
> Claude Code 実行用 / picofuri2 機能統合

---

## 概要

Windows版ピコフリの機能をLinux版ピコフリ2に移植する。
**省略する機能:** 仕入れ中個数・仕入れ実績（Google Sheets依存のため）

---

## 作業ルール

- CLAUDE.md のルールに従う
- ブランチ: `feat/phase1-full-features`
- 1ファイルずつ変更・テスト・報告してから次へ
- DB変更前に必ずバックアップ:
  ```bash
  cp ~/picofuri2/database.sqlite ~/picofuri2/database.sqlite.bak_$(date +%Y%m%d_%H%M%S)
  ```

---

## 変更ファイル一覧（実装順）

1. `src/config/` 以下に設定ファイルを新規作成
2. `src/models/index.js` — DBスキーマ拡張
3. `src/scrapers/MercariApiScraper.js` — listingCount追加
4. `src/scrapers/YahooScraper.js` — listingCount追加
5. `src/services/FilterService.js` — 新規作成（LayerA）
6. `src/services/CrossmallService.js` — 注文蓄積追加
7. `src/services/NotificationService.js` — フォーマット完全書き換え
8. `src/services/ScrapingService.js` — FilterService連携

---

## STEP 1：設定ファイル作成

### src/config/ngWords.js

```javascript
// NG語句リスト（固定）
module.exports = [
  '開封済', '使用済', '使用中', '中古', '箱なし', '箱無し',
  'ジャンク', '破損', '傷あり', '傷有り', '汚れあり', '汚れ有り',
  '訳あり', '訳有り', '欠品', 'シール剥がし', 'シール剥がれ',
  'タグなし', 'タグ無し', '期限切れ', '賞味期限切れ',
  '未使用に近い', '目立った傷や汚れなし', 'やや傷や汚れあり',
  '傷や汚れあり', '全体的に状態が悪い'
];
```

### src/config/shippingCost.js

```javascript
// 送料辞書（CROSSMALL delivery_type_name → 送料）
const SHIPPING_COST_MAP = {
  '宅配便(日本郵便 楽天倉庫出荷)': 620,
  '追跡可能メール便(日本郵便)': 220,
  'メール便(日本郵便)': 340,
  '宅配便(佐川急便)': 550,
};
const DEFAULT_SHIPPING_COST = 620;

function getShippingCost(deliveryType) {
  if (!deliveryType) return DEFAULT_SHIPPING_COST;
  return SHIPPING_COST_MAP[deliveryType] ?? DEFAULT_SHIPPING_COST;
}

module.exports = { getShippingCost, SHIPPING_COST_MAP, DEFAULT_SHIPPING_COST };
```

### src/config/layerA.json

```json
{
  "layer_a_min_hours": 0,
  "layer_a_max_hours": 48,
  "layer_a_min_expiry_months": 5,
  "layer_a_skip_stock_days": 25
}
```

---

## STEP 2：DBスキーマ拡張

### src/models/index.js の変更点

**Keyword モデルに追加するカラム:**

```javascript
minPrice: {
  type: DataTypes.INTEGER,
  defaultValue: 0
},
maxPrice: {
  type: DataTypes.INTEGER,
  defaultValue: 999999
},
crossmallItemCode: {
  type: DataTypes.STRING,
  allowNull: true
},
itemCodes: {
  type: DataTypes.TEXT,
  allowNull: true
  // カンマ区切りの複数SKU文字列
},
globalExcludeEnabled: {
  type: DataTypes.BOOLEAN,
  defaultValue: true
}
// excludeKeywords は既存（TEXT型、カンマ区切りに変更）
```

**DetectedItem モデルに追加するカラム:**

```javascript
listingCount: {
  type: DataTypes.INTEGER,
  allowNull: true
  // 検索時の総出品件数（出品レア度の計算に使用）
},
sellerRating: {
  type: DataTypes.FLOAT,
  allowNull: true
}
```

**CrossmallProduct モデルに追加するカラム:**

```javascript
lastSalePrice: {
  type: DataTypes.INTEGER,
  defaultValue: 0
},
lastSaleDate: {
  type: DataTypes.DATE,
  allowNull: true
},
deliveryType: {
  type: DataTypes.STRING,
  allowNull: true
}
```

**新規: CrossmallSale モデル（注文蓄積テーブル）:**

```javascript
const CrossmallSale = sequelize.define('CrossmallSale', {
  orderNumber: {
    type: DataTypes.STRING,
    allowNull: false
  },
  lineNo: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  itemCode: {
    type: DataTypes.STRING,
    allowNull: false
  },
  orderDate: {
    type: DataTypes.DATEONLY,
    allowNull: false
  },
  amount: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  unitPrice: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  amountPrice: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  deliveryType: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  indexes: [
    { unique: true, fields: ['orderNumber', 'lineNo'] },
    { fields: ['itemCode'] },
    { fields: ['orderDate'] }
  ]
});
```

**初期データ更新（既存キーワードにminPrice/maxPrice追加）:**

```javascript
// 既存Keywordレコードにデフォルト値を設定
await Keyword.update(
  { minPrice: 0, maxPrice: 999999, globalExcludeEnabled: true },
  { where: { minPrice: null } }
);
```

テスト:
```bash
node -e "require('dotenv').config(); const {initDB}=require('./src/models/index.js'); initDB().then(()=>console.log('OK'))"
```
`CrossmallSale` テーブルが生成されること、既存データが保持されることを確認。

---

## STEP 3：スクレイパーに listingCount を追加

### MercariApiScraper.js の変更

`search()` メソッドの返却値に `listingCount` を追加:

```javascript
// response.data.meta.numFound を整数で返す
const listingCount = parseInt(response.data.meta?.numFound) || null;

return {
  items: items.map(item => ({
    // 既存フィールド...
    listingCount: listingCount  // 全件に同じ値をセット
  }))
};
```

### YahooScraper.js の変更

```javascript
// items.length を総件数として使用（Yahoo!フリマは総数取得不可）
const listingCount = items.length;
return items.map(item => ({
  // 既存フィールド...
  listingCount: listingCount
}));
```

テスト:
```bash
node -e "
const M = require('./src/scrapers/MercariApiScraper.js');
const s = new M();
s.initialize().then(() => s.search('オキシカット').then(r => {
  console.log('listingCount:', r[0]?.listingCount);
}));
"
```

---

## STEP 4：FilterService.js 新規作成

### src/services/FilterService.js

Windows版 LayerAFilterService.js を移植する。

```javascript
const ngWords = require('../config/ngWords.js');
const layerAConfig = require('../config/layerA.json');

// グローバル除外キーワード（可変）
const GLOBAL_EXCLUDE_KEYWORDS = ['空箱', 'サンプル'];

class FilterService {

  // ========== タイトルフィルタ（検索結果の事前絞り込み）==========
  // 全角英数→半角 / 正規化 / AND判定 / フレーズ一致
  matchesKeyword(title, keyword) {
    // 1. 正規化
    const normalize = str => str
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[+＋]/g, 'プラス')
      .replace(/[^\w\u3040-\u30FF\u4E00-\u9FFF\u3000-\u303F ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // 2. 英語機能語除外
    const STOP_WORDS = ['no', 'the', 'for', 'and', 'with', 'from', 'de', 'la', 'le'];

    const normTitle   = normalize(title);
    const normKeyword = normalize(keyword);

    // 3. 有効ワード抽出（機能語除外）
    const words = normKeyword.split(/\s+/).filter(w => w && !STOP_WORDS.includes(w));
    if (words.length === 0) return true; // 有効ワードなし→全件通過

    // 4. AND判定
    if (words.every(w => normTitle.includes(w))) return true;

    // 5. フレーズ一致（スペース除去後）
    const phraseTitle   = normTitle.replace(/\s/g, '');
    const phraseKeyword = normKeyword.replace(/\s/g, '');
    if (phraseTitle.includes(phraseKeyword)) return true;

    return false;
  }

  // ========== LayerA フィルタ ==========
  // 戻り値: { pass: boolean, reason: string | null }

  check(item, keyword) {
    const price = item.price;
    const title = (item.title || '').toLowerCase();
    const listedAt = item.listedAt;
    const platform = item.platform;

    // 1. 下限価格
    if (keyword.minPrice > 0 && price < keyword.minPrice) {
      return { pass: false, reason: `下限価格未満 (¥${price} < ¥${keyword.minPrice})` };
    }

    // 1.5 上限価格
    if (keyword.maxPrice < 999999 && price > keyword.maxPrice) {
      return { pass: false, reason: `上限価格超過 (¥${price} > ¥${keyword.maxPrice})` };
    }

    // 3. 出品経過時間（mercariはlistedAtがnullでもOK）
    if (listedAt) {
      const hoursOld = (Date.now() - new Date(listedAt).getTime()) / (1000 * 3600);
      if (hoursOld > layerAConfig.layer_a_max_hours) {
        return { pass: false, reason: `出品経過時間超過 (${Math.round(hoursOld)}h > ${layerAConfig.layer_a_max_hours}h)` };
      }
    } else if (platform === 'yahoo_flea') {
      // Yahoo!フリマはlistedAt取得不可のためスキップしない
    }

    // 5. NG語句
    for (const word of ngWords) {
      if (title.includes(word.toLowerCase())) {
        return { pass: false, reason: `NG語句検出: "${word}"` };
      }
    }

    // 6. グローバル除外キーワード
    if (keyword.globalExcludeEnabled !== false) {
      for (const word of GLOBAL_EXCLUDE_KEYWORDS) {
        if (title.includes(word.toLowerCase())) {
          return { pass: false, reason: `全体除外: "${word}"` };
        }
      }
    }

    // 6.5. キーワード個別除外
    const individualExcludes = (keyword.excludeKeywords || '')
      .split(',').map(w => w.trim()).filter(Boolean);
    for (const word of individualExcludes) {
      if (title.includes(word.toLowerCase())) {
        return { pass: false, reason: `個別除外: "${word}"` };
      }
    }

    return { pass: true, reason: null };
  }

  // 過剰在庫スキップ（在庫日数 > 25日）
  isOverstock(stock, sales28) {
    if (!sales28 || sales28 === 0) return false; // 売上0は欠品の可能性→スキップしない
    const stockDays = Math.round(stock / (sales28 / 28));
    return stockDays > layerAConfig.layer_a_skip_stock_days;
  }
}

module.exports = FilterService;
```

テスト:
```bash
node -e "
const F = require('./src/services/FilterService.js');
const f = new F();

// タイトルマッチテスト
console.log(f.matchesKeyword('オキシカット PREMIUM 30日分', 'オキシカット')); // true
console.log(f.matchesKeyword('risou no Coffee 30包入り', 'risou no Coffee 30')); // true

// LayerAテスト
const kw = { minPrice: 3000, maxPrice: 8000, globalExcludeEnabled: true, excludeKeywords: 'まとめ' };
console.log(f.check({ price: 2000, title: 'オキシカット', platform: 'mercari', listedAt: new Date() }, kw)); // pass:false 下限
console.log(f.check({ price: 5000, title: '開封済オキシカット', platform: 'mercari', listedAt: new Date() }, kw)); // pass:false NG語句
console.log(f.check({ price: 5000, title: 'オキシカット 新品', platform: 'mercari', listedAt: new Date() }, kw)); // pass:true
"
```

---

## STEP 5：CrossmallService.js に注文蓄積を追加

### 追加メソッド

```javascript
// 注文蓄積メイン（初回: 90日 / 差分: 最新日-2日）
async syncOrders() {
  const INITIAL_DAYS = 90;
  const MARGIN_DAYS = 2;
  const SAVE_INTERVAL = 50;

  // 最新注文日を取得
  const latest = await CrossmallSale.findOne({
    order: [['orderDate', 'DESC']],
    attributes: ['orderDate']
  });

  const today = new Date();
  let fromDate;
  if (!latest) {
    // 初回: 90日前から
    fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - INITIAL_DAYS);
    console.log(`[CrossmallService] 初回同期: 過去${INITIAL_DAYS}日分`);
  } else {
    // 差分: 最新日 - MARGIN_DAYS
    fromDate = new Date(latest.orderDate);
    fromDate.setDate(fromDate.getDate() - MARGIN_DAYS);
    console.log(`[CrossmallService] 差分同期: ${fromDate.toISOString().slice(0,10)}〜`);
  }

  // 既存注文番号を取得（重複スキップ用）
  const existingOrders = new Set(
    (await CrossmallSale.findAll({ attributes: ['orderNumber'] }))
      .map(r => r.orderNumber)
  );

  // 日付ループ
  let savedCount = 0;
  const cursor = new Date(fromDate);

  while (cursor <= today) {
    const dateStr = cursor.toISOString().slice(0, 10);
    let orderNumber = '0';
    let page = 0;

    while (true) {
      const xml = await this._request('get_order', {
        order_date: dateStr,
        order_number: orderNumber
      });

      const orders = this._parseXml(xml, 'Result');
      if (orders.length === 0) break;

      for (const order of orders) {
        const num = this._parseXmlTag(order, 'order_number');
        const date = this._parseXmlTag(order, 'order_date')?.slice(0, 10);
        const delivery = this._parseXmlTag(order, 'delivery_type_name');

        if (!num || existingOrders.has(num)) continue;

        const details = this._parseXml(order, 'detail');
        let lineNo = 1;

        for (const detail of details) {
          const itemCode = this._parseXmlTag(detail, 'item_code');
          const qty = parseInt(this._parseXmlTag(detail, 'quantity')) || 1;
          const amountPrice = parseInt(this._parseXmlTag(detail, 'amount_price')) || 0;
          const unitPrice = qty > 0 ? Math.round(amountPrice / qty) : 0;

          if (!itemCode) continue;

          await CrossmallSale.upsert({
            orderNumber: num,
            lineNo,
            itemCode,
            orderDate: date || dateStr,
            amount: qty,
            unitPrice,
            amountPrice,
            deliveryType: delivery || null
          });

          lineNo++;
          savedCount++;

          if (savedCount % SAVE_INTERVAL === 0) {
            console.log(`[CrossmallService] 注文蓄積中... ${savedCount}件`);
          }
        }

        existingOrders.add(num);
        orderNumber = num; // ページネーション用カーソル
      }

      if (orders.length < 100) break;
      page++;
      await new Promise(r => setTimeout(r, 1000));
    }

    cursor.setDate(cursor.getDate() + 1);
    await new Promise(r => setTimeout(r, 300));
  }

  // 90日超レコードを削除
  const pruneDate = new Date();
  pruneDate.setDate(pruneDate.getDate() - 90);
  await CrossmallSale.destroy({ where: { orderDate: { [Op.lt]: pruneDate.toISOString().slice(0,10) } } });

  console.log(`[CrossmallService] 注文蓄積完了: 新規${savedCount}件`);

  // CrossmallProductの統計を更新
  await this._updateProductStats();
}

// CrossmallProduct の lastSalePrice / lastSaleDate / sales7 / sales28 / deliveryType を更新
async _updateProductStats() {
  const now = new Date();
  const day7  = new Date(now); day7.setDate(day7.getDate() - 7);
  const day28 = new Date(now); day28.setDate(day28.getDate() - 28);

  // 全SKUを集計
  const results = await CrossmallSale.findAll({
    attributes: [
      'itemCode',
      [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day7.toISOString().slice(0,10)}' THEN amount ELSE 0 END`)), 'sales7'],
      [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day28.toISOString().slice(0,10)}' THEN amount ELSE 0 END`)), 'sales28'],
      [sequelize.fn('MAX', sequelize.col('orderDate')), 'lastSaleDate'],
    ],
    where: { orderDate: { [Op.gte]: day28.toISOString().slice(0,10) } },
    group: ['itemCode']
  });

  for (const row of results) {
    // 最新注文の単価と配送種別
    const latest = await CrossmallSale.findOne({
      where: { itemCode: row.itemCode },
      order: [['orderDate', 'DESC'], ['createdAt', 'DESC']]
    });

    await CrossmallProduct.upsert({
      itemCode: row.itemCode,
      sales7: parseInt(row.dataValues.sales7) || 0,
      sales28: parseInt(row.dataValues.sales28) || 0,
      lastSaleDate: row.dataValues.lastSaleDate,
      lastSalePrice: latest?.unitPrice || 0,
      deliveryType: latest?.deliveryType || null,
      lastSyncedAt: now
    });
  }

  console.log(`[CrossmallService] 統計更新完了: ${results.length}SKU`);
}
```

**syncAll() の修正:**
既存の `syncAll()` に `syncOrders()` を追加:

```javascript
async syncAll() {
  await this.syncOrders();  // 注文蓄積（先に実行）
  // 既存の在庫同期処理...
}
```

**必要なimport追加:**
```javascript
const { Op } = require('sequelize');
const { CrossmallProduct, CrossmallSale, sequelize } = require('../models/index.js');
```

テスト（注文が1件以上取得できること）:
```bash
node -e "
require('dotenv').config();
const {initDB, CrossmallSale} = require('./src/models/index.js');
const CrossmallService = require('./src/services/CrossmallService.js');
initDB().then(async () => {
  const s = new CrossmallService();
  await s.syncOrders();
  const cnt = await CrossmallSale.count();
  console.log('CrossmallSale件数:', cnt);
});
"
```
※ 初回は90日分取得のため5〜10分かかる可能性あり。

---

## STEP 6：NotificationService.js 完全書き換え

### 通知フォーマット（省略版）

```
[判定ラベル]

🛒 [商品タイトル]
¥[価格]
🔗 [URL]

📦 在庫X個 | 28日X個 | 7日X個 | 最終M/D
📅 在庫日数: 約X日
🔥 出品レア度: [ラベル]（X件）
💰 直近販売¥X | 上限仕入¥X
[利益ライン]
```

### 実装

```javascript
const { getShippingCost } = require('../config/shippingCost.js');
const axios = require('axios');

class NotificationService {
  constructor() {
    this.token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    this.lineEnabled = process.env.LINE_NOTIFY_ENABLED === 'true';
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_ADMIN_ID;
    this.telegramEnabled = process.env.TELEGRAM_NOTIFY_ENABLED === 'true';
  }

  // ===== 判定ラベル =====
  calcJudgement(profitRate, sales7, stockDays, isRare) {
    if (profitRate > 60)  return '⚠️ 利益率確認';
    if (profitRate <= -50) return '⚠️ 個数確認';
    if (profitRate < 0)   return '❌ 赤字';
    if (profitRate <= 5)  return '❌ 利益なし';
    if (profitRate < 12)  return '❌ 利益薄い';
    if (profitRate >= 12 && stockDays !== Infinity && stockDays <= 7) return '🚨 緊急仕入';
    if (profitRate >= 30 && sales7 >= 3) return '💎 高利益';
    if (profitRate >= 20 && sales7 >= 3 && stockDays <= 14) return '✅ 即買い';
    if (isRare) return '🔥 レア即買';
    if (sales7 <= 2) return '🤔 売行鈍い';
    return '🤔 要検討';
  }

  // ===== 在庫日数 =====
  calcStockDays(stock, sales28) {
    if (stock === 0) return 0;
    if (!sales28 || sales28 === 0) return Infinity;
    return Math.round(stock / (sales28 / 28));
  }

  // ===== 上限仕入価格 =====
  calcPurchaseLimit(lastSalePrice, shippingCost) {
    if (!lastSalePrice || lastSalePrice <= 0) return null;
    if (lastSalePrice <= 3000) {
      return Math.round(lastSalePrice * 0.9 - shippingCost - 300);
    }
    return Math.round(lastSalePrice * 0.78 - shippingCost);
  }

  // ===== 利益計算 =====
  calcProfit(lastSalePrice, shippingCost, fleaPrice) {
    if (!lastSalePrice || lastSalePrice <= 0) return null;
    const profit = Math.round(lastSalePrice * 0.9 - shippingCost - fleaPrice);
    const profitRate = (profit / lastSalePrice) * 100;
    return { profit, profitRate: Math.round(profitRate * 10) / 10 };
  }

  // ===== 出品レア度 =====
  calcRarity(listingCount) {
    if (!listingCount) return '取得不能';
    if (listingCount <= 2) return '🔥 レア';
    if (listingCount <= 7) return '普通';
    return '多い';
  }

  // ===== メッセージ構築 =====
  buildMessage(item, keyword, product) {
    const platform = item.platform === 'mercari' ? 'メルカリ' : 'Yahoo!フリマ';

    // CROSSMALL情報
    const stock     = product?.stock ?? 0;
    const sales28   = product?.sales28 ?? 0;
    const sales7    = product?.sales7 ?? 0;
    const lastSalePrice = product?.lastSalePrice ?? 0;
    const deliveryType  = product?.deliveryType ?? null;
    const lastSaleDate  = product?.lastSaleDate ?? null;

    const shippingCost = getShippingCost(deliveryType);
    const stockDays    = this.calcStockDays(stock, sales28);
    const purchaseLimit = this.calcPurchaseLimit(lastSalePrice, shippingCost);
    const profitResult  = this.calcProfit(lastSalePrice, shippingCost, item.price);
    const profitRate    = profitResult?.profitRate ?? 0;
    const isRare = (item.listingCount ?? 99) <= 2;

    const judgement = lastSalePrice > 0
      ? this.calcJudgement(profitRate, sales7, stockDays, isRare)
      : '📋 参考';

    // 日付表示
    const lastSaleDateStr = lastSaleDate
      ? `${new Date(lastSaleDate).getMonth() + 1}/${new Date(lastSaleDate).getDate()}`
      : '不明';

    const stockDaysStr = stockDays === Infinity ? '∞' : `約${stockDays}日`;
    const rarityLabel = this.calcRarity(item.listingCount);

    // 価格ライン
    const priceStr = `¥${item.price.toLocaleString()}`;

    // 利益ライン
    let profitLine = '';
    if (profitResult && lastSalePrice > 0) {
      const sign = profitResult.profit >= 0 ? '+' : '';
      const profitIcon = profitResult.profit >= 0 ? '✅' : '⚠️';
      profitLine = `${profitIcon} 利益見込み ${sign}¥${profitResult.profit.toLocaleString()}（送料¥${shippingCost}）利益率${profitResult.profitRate}%`;
    }

    // CROSSMALLライン
    const crossmallLine = product
      ? `📦 在庫${stock}個 | 28日${sales28}個 | 7日${sales7}個 | 最終${lastSaleDateStr}`
      : '📦 在庫情報なし';

    const stockDaysLine = `📅 在庫日数: ${stockDaysStr}`;

    const rarityLine = `🔥 出品レア度: ${rarityLabel}（${item.listingCount ?? '?'}件）`;

    const priceLine = purchaseLimit !== null
      ? `💰 直近販売¥${lastSalePrice.toLocaleString()} | 上限仕入¥${purchaseLimit.toLocaleString()}`
      : '';

    const lines = [
      judgement,
      '',
      `🛒 ${item.title}`,
      priceStr,
      `🔗 ${item.itemUrl}`,
      '',
      crossmallLine,
      stockDaysLine,
      rarityLine,
      ...(priceLine ? [priceLine] : []),
      ...(profitLine ? [profitLine] : []),
    ];

    return lines.join('\n');
  }

  // ===== 送信メソッド =====
  async sendTelegram(message) {
    if (!this.telegramEnabled) return;
    if (!this.telegramToken || !this.telegramChatId) return;

    // Telegram は4096文字制限
    const chunks = [];
    for (let i = 0; i < message.length; i += 4000) {
      chunks.push(message.slice(i, i + 4000));
    }

    for (const chunk of chunks) {
      await axios.post(
        `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
        { chat_id: this.telegramChatId, text: chunk },
        { timeout: 10000 }
      ).catch(e => console.error('[Telegram] 送信エラー:', e.message));
    }
  }

  async sendLine(message) {
    if (!this.lineEnabled) return;
    if (!this.token || this.token === 'REPLACE_ME') return;
    await axios.post(
      'https://api.line.me/v2/bot/message/broadcast',
      { messages: [{ type: 'text', text: message }] },
      { headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    ).catch(e => console.error('[LINE] 送信エラー:', e.message));
  }

  async notifyNewItem(item, keyword, product) {
    const message = this.buildMessage(item, keyword, product);
    console.log(`[通知] ${item.platform} "${item.title.slice(0,30)}" ¥${item.price}`);
    await this.sendTelegram(message);
    await this.sendLine(message);
  }
}

module.exports = NotificationService;
```

テスト（メッセージ構築の確認）:
```bash
node -e "
require('dotenv').config();
const {initDB} = require('./src/models/index.js');
const N = require('./src/services/NotificationService.js');
initDB().then(() => {
  const n = new N();
  const msg = n.buildMessage(
    { title:'オキシカット PREMIUM 30日分', price:5300, itemUrl:'https://jp.mercari.com/item/m123', platform:'mercari', listingCount:5 },
    { minPrice:3000, maxPrice:8000, globalExcludeEnabled:true, excludeKeywords:'' },
    { stock:10, sales28:25, sales7:5, lastSalePrice:6800, deliveryType:'追跡可能メール便(日本郵便)', lastSaleDate:new Date() }
  );
  console.log(msg);
});
"
```

---

## STEP 7：ScrapingService.js にFilterServiceを組み込む

### 変更点

```javascript
const FilterService = require('./FilterService.js');

class ScrapingService {
  constructor() {
    // 既存...
    this.filter = new FilterService();
  }

  async _processItems(items, keyword) {
    // CROSSMALL情報を事前に取得
    const itemCodes = keyword.crossmallItemCode
      ? keyword.crossmallItemCode.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    let product = null;
    if (itemCodes.length > 0) {
      product = await CrossmallProduct.findOne({ where: { itemCode: itemCodes[0] } });
    }

    for (const item of items) {
      // 1. タイトルフィルタ
      if (!this.filter.matchesKeyword(item.title, keyword.keyword)) continue;

      // 2. LayerAフィルタ
      const layerResult = this.filter.check(item, keyword);
      if (!layerResult.pass) {
        // console.log(`[フィルタ] "${item.title.slice(0,20)}": ${layerResult.reason}`);
        continue;
      }

      // 3. 過剰在庫スキップ
      if (product && this.filter.isOverstock(product.stock, product.sales28)) {
        continue;
      }

      // 4. DB重複チェック（既存の findOne + create パターン）
      const existing = await DetectedItem.findOne({ where: { itemId: item.id } });
      if (existing) continue;

      let detected;
      try {
        detected = await DetectedItem.create({
          itemId: item.id,
          platform: item.platform,
          title: item.title,
          price: item.price,
          imageUrl: item.imageUrl,
          itemUrl: item.itemUrl,
          listedAt: item.listedAt,
          listingCount: item.listingCount ?? null,
          keywordId: keyword.id,
          notified: false
        });
      } catch (e) {
        if (e.name === 'SequelizeUniqueConstraintError') continue;
        throw e;
      }

      // 5. 通知
      await this.notification.notifyNewItem(item, keyword, product);
      await detected.update({ notified: true, notifiedAt: new Date() });
      this.stats.notified++;
    }
  }
}
```

---

## STEP 8：index.js の syncOrders 追加

`src/index.js` の CROSSMALL同期cronに `syncOrders` を追加:

```javascript
// 起動時に注文蓄積を1回実行（バックグラウンド）
setTimeout(() => crossmall.syncOrders().catch(e => console.error('syncOrders error:', e)), 10000);

// 6時間ごとに注文蓄積（2時間ごとの syncAll に含まれる）
// → syncAll() の中で syncOrders() が呼ばれるので追加不要
```

---

## STEP 9：統合テスト

```bash
# 1. LINE_NOTIFY_ENABLED=false に設定
# 2. 起動して1スキャン実行
node src/index.js

# 3. フィルタが動作していることを確認（ログに「フィルタ」が出ることを確認）
# 4. pm2 restart picofuri2 --update-env
```

---

## STEP 10：git diff main を提示してオーナー承認後マージ

```bash
git add .
git commit -m "feat: phase1 LayerAフィルタ・CROSSMALL蓄積・通知フォーマット完全移植"
git diff main
# → オーナー承認後 merge
```

---

## 完了報告フォーマット

| 項目 | 内容 |
|------|------|
| 完了ファイル | |
| CrossmallSale件数 | |
| フィルタ動作確認 | |
| 通知メッセージサンプル | |
| テスト結果 | |
| 懸念事項 | |
