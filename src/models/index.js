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
