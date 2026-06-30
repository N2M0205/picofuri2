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

  _isExcluded(title, excludeKeywords) {
    const GLOBAL_EXCLUDE = ['まとめ', 'まとめ売り', 'セット', 'ジャンク', '偽物', 'レプリカ', '空箱', 'サンプル'];
    const allExcludes = [...GLOBAL_EXCLUDE, ...excludeKeywords];
    return allExcludes.some(ex => title.includes(ex));
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
      console.log(`[ScrapingService] スキャン完了: ${elapsed}秒 / 通知: ${this.stats.notified}件`);
      this.lastRunAt = new Date();

    } catch (err) {
      console.error('[ScrapingService] スキャンエラー:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  async _processItems(items, keyword) {
    for (const item of items) {
      if (this._isExcluded(item.title, keyword.excludeKeywords || [])) continue;

      // findOrCreate()はSQLITE_BUSYの既知原因のため使わない
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

      if (created && !detected.notified) {
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
