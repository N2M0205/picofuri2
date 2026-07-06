const { Sequelize, DataTypes } = require('sequelize');
const path = require('path');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, '../../database.sqlite'),
  logging: false,
  pool: { max: 1 },
  retry: { max: 5 }
});

// キーワードテーブル
const Keyword = sequelize.define('Keyword', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  keyword: { type: DataTypes.STRING, allowNull: false },
  platforms: {
    type: DataTypes.TEXT,
    get() { return JSON.parse(this.getDataValue('platforms') || '[]'); },
    set(v) { this.setDataValue('platforms', JSON.stringify(v)); }
  },
  // Phase1: カンマ区切り文字列に変更（FilterService.check が split で扱う）
  excludeKeywords: {
    type: DataTypes.TEXT,
    defaultValue: ''
  },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  // Phase1 追加
  minPrice: { type: DataTypes.INTEGER, defaultValue: 0 },
  maxPrice: { type: DataTypes.INTEGER, defaultValue: 999999 },
  crossmallItemCode: { type: DataTypes.STRING, allowNull: true },
  itemCodes: { type: DataTypes.TEXT, allowNull: true },
  globalExcludeEnabled: { type: DataTypes.BOOLEAN, defaultValue: true }
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
  notifiedAt: { type: DataTypes.DATE },
  // Phase1 追加
  listingCount: { type: DataTypes.INTEGER, allowNull: true },
  sellerRating: { type: DataTypes.FLOAT, allowNull: true }
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
  lastSyncedAt: { type: DataTypes.DATE },
  // Phase1 追加
  lastSalePrice: { type: DataTypes.INTEGER, defaultValue: 0 },
  lastSaleDate: { type: DataTypes.DATE, allowNull: true },
  deliveryType: { type: DataTypes.STRING, allowNull: true },
  // n派生コード名寄せ用: 末尾"n"を除去したベースitemCode
  // 自身がベースの場合は itemCode と同値、n派生の場合はベース側の itemCode
  // 実体単位の販売実績合算 (階層化スキャンでの利用予定) の起点
  baseItemCode: { type: DataTypes.STRING, allowNull: true }
}, { timestamps: true });

// Phase1 新規: CROSSMALL注文蓄積テーブル
const CrossmallSale = sequelize.define('CrossmallSale', {
  orderNumber: { type: DataTypes.STRING, allowNull: false },
  lineNo: { type: DataTypes.INTEGER, allowNull: false },
  itemCode: { type: DataTypes.STRING, allowNull: false },
  orderDate: { type: DataTypes.DATEONLY, allowNull: false },
  amount: { type: DataTypes.INTEGER, defaultValue: 1 },
  unitPrice: { type: DataTypes.INTEGER, defaultValue: 0 },
  amountPrice: { type: DataTypes.INTEGER, defaultValue: 0 },
  deliveryType: { type: DataTypes.STRING, allowNull: true }
}, {
  indexes: [
    { unique: true, fields: ['orderNumber', 'lineNo'] },
    { fields: ['itemCode'] },
    { fields: ['orderDate'] }
  ]
});

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
  // SQLITE_BUSY対策（既知の教訓: WALモード + busy_timeoutが必須）
  // sync前にawaitableに設定
  await sequelize.query('PRAGMA journal_mode = WAL');
  await sequelize.query('PRAGMA busy_timeout = 5000');

  // CrossmallSale は alter:true で inline UNIQUE バグを再注入されるため、bulk syncから外して個別管理
  // Sequelize 6 + SQLite で indexes:[{unique:true, fields:['col1','col2']}] が
  // 各カラムに NOT NULL UNIQUE を inline 付与してしまう既知バグへの対策
  await Keyword.sync({ alter: true });
  await DetectedItem.sync({ alter: true });
  await CrossmallProduct.sync({ alter: true });

  // CrossmallSale 専用処理: 存在しなければforce、存在すればバグ検査のみ
  const [tableExists] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE name='CrossmallSales' AND type='table'"
  );
  if (tableExists.length === 0) {
    console.log('[DB] CrossmallSales を新規作成');
    await CrossmallSale.sync({ force: true });
  } else {
    const [tblRows] = await sequelize.query(
      "SELECT sql FROM sqlite_master WHERE name='CrossmallSales' AND type='table'"
    );
    const tableSql = tblRows[0]?.sql || '';
    const hasInlineUniqueBug = /\b(orderNumber|lineNo)\b[^,)]*\bUNIQUE\b/.test(tableSql);
    if (hasInlineUniqueBug) {
      const [cntRows] = await sequelize.query('SELECT COUNT(*) AS n FROM CrossmallSales');
      if (cntRows[0].n === 0) {
        console.warn('[DB] CrossmallSales inline-UNIQUEバグ検知。空テーブルのため自動再作成');
        await sequelize.query('DROP TABLE CrossmallSales');
        await CrossmallSale.sync({ force: true });
      } else {
        console.error('[DB] CrossmallSales inline-UNIQUEバグ検知 + データあり。手動対応が必要');
      }
    }
  }

  // 複合UNIQUE保護インデックス（冪等）
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crossmall_sales_order_line
    ON CrossmallSales (orderNumber, lineNo)
  `);

  // 既存Keywordレコードの新カラムにデフォルト値を補完（NULL対応）
  await Keyword.update(
    { minPrice: 0, maxPrice: 999999, globalExcludeEnabled: true },
    { where: { minPrice: null } }
  );

  // 旧スキーマ excludeKeywords='[]' (JSON-array文字列) を空文字に正規化
  await Keyword.update(
    { excludeKeywords: '' },
    { where: { excludeKeywords: '[]' } }
  );

  const count = await Keyword.count();
  if (count === 0) {
    await Keyword.bulkCreate(INITIAL_KEYWORDS);
    console.log(`[DB] ${INITIAL_KEYWORDS.length}件のキーワードを初期登録しました`);
  }
  console.log('[DB] 初期化完了');
}

module.exports = { sequelize, Keyword, DetectedItem, CrossmallProduct, CrossmallSale, initDB };
