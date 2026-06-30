const { Keyword, DetectedItem, CrossmallProduct } = require('../models/index.js');
const MercariApiScraper = require('../scrapers/MercariApiScraper.js');
const YahooScraper = require('../scrapers/YahooScraper.js');
const CrossmallService = require('./CrossmallService.js');
const NotificationService = require('./NotificationService.js');
const FilterService = require('./FilterService.js');

class ScrapingService {
  constructor() {
    this.mercariScraper = new MercariApiScraper();
    this.yahooScraper = new YahooScraper();
    this.crossmall = new CrossmallService();
    this.notification = new NotificationService();
    this.filter = new FilterService();
    this.isRunning = false;
    this.lastRunAt = null;
    this.stats = { success: 0, error: 0, notified: 0, filtered: 0 };
  }

  async initialize() {
    await this.mercariScraper.initialize();
    console.log('[ScrapingService] 初期化完了');
  }

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

      const mercariTasks = mercariKeywords.map(kw => async () => {
        const items = await this.mercariScraper.search(kw.keyword);
        await this._processItems(items, kw);
        return items.length;
      });

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
      console.log(`[ScrapingService] スキャン完了: ${elapsed}秒 / 通知: ${this.stats.notified}件 / フィルタ除外: ${this.stats.filtered}件`);
      this.lastRunAt = new Date();

    } catch (err) {
      console.error('[ScrapingService] スキャンエラー:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  async _processItems(items, keyword) {
    // 当該キーワードに紐づく CrossmallProduct を事前取得
    let product = null;
    if (keyword.crossmallItemCode) {
      product = await CrossmallProduct.findOne({ where: { itemCode: keyword.crossmallItemCode } });
    }
    if (!product) {
      try {
        product = await this.crossmall.findProductByKeyword(keyword);
      } catch { /* CROSSMALL情報なしでも通知は出す */ }
    }

    for (const item of items) {
      // 1. タイトルフィルタ（無関係な検索結果の事前足切り）
      if (!this.filter.matchesKeyword(item.title, keyword.keyword)) {
        this.stats.filtered++;
        continue;
      }

      // 2. LayerA フィルタ（価格・経過時間・NG語句・除外）
      const layerResult = this.filter.check(item, keyword);
      if (!layerResult.pass) {
        this.stats.filtered++;
        continue;
      }

      // 3. 過剰在庫スキップ（25日超）
      if (product && this.filter.isOverstock(product.stock, product.sales28)) {
        this.stats.filtered++;
        continue;
      }

      // 4. DB重複チェック（既出は通知しない）
      const existing = await DetectedItem.findOne({ where: { itemId: item.id } });
      if (existing) continue;

      // 5. 新規登録（findOrCreate回避でSQLITE_BUSY対策）
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
      } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') continue;
        throw err;
      }

      // 6. 通知（NotificationServiceがLINE/Telegramを内部で判定）
      await this.notification.notifyNewItem(item, keyword, product);
      await detected.update({ notified: true, notifiedAt: new Date() });
      this.stats.notified++;
    }
  }
}

module.exports = ScrapingService;
