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
    this.stats = { success: 0, error: 0, notified: 0, filtered: 0, capped: 0 };
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

    // per-scan 状態はローカル変数に閉じ込めて、インスタンス変数のリセット漏れを構造的に排除する。
    // _processItems は並列実行されるためリアルタイムでカウンタ共有が必要 →
    // オブジェクトで包んで参照渡し（返り値集計だと並列中のキャップ判定に間に合わない）。
    // env はスキャン毎に読み直し、pm2 restart --update-env 反映を早める。
    // yahooRateLimited: 429検出時のサーキットブレーカー、残Yahooキーワードを全スキップ。
    const scanState = { notifyCount: 0, cappedCount: 0, capHitLogged: false, yahooRateLimited: false };
    const cap = parseInt(process.env.NOTIFY_CAP_PER_SCAN) || 0;

    // YAHOO_SCRAPING_ENABLED=false でYahooスキャン全体をスキップ（rate limit対策の運用フラグ）
    const yahooEnabled = process.env.YAHOO_SCRAPING_ENABLED !== 'false';
    // YAHOO_KEYWORD_ALLOWLIST=カンマ区切りキーワード名 で Yahoo対象を絞り込む（段階的再開の検証用）
    // 空文字/未設定なら絞り込みなし（全 yahoo_flea キーワードが対象）
    const yahooAllowlist = (process.env.YAHOO_KEYWORD_ALLOWLIST || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    try {
      const keywords = await Keyword.findAll({ where: { isActive: true } });
      const mercariKeywords = keywords.filter(k => k.platforms.includes('mercari'));
      let yahooKeywords = yahooEnabled ? keywords.filter(k => k.platforms.includes('yahoo_flea')) : [];

      if (!yahooEnabled) {
        console.log('[ScrapingService] YAHOO_SCRAPING_ENABLED=false: Yahoo!フリマスキャン全体をスキップ');
      } else if (yahooAllowlist.length > 0) {
        const before = yahooKeywords.length;
        yahooKeywords = yahooKeywords.filter(k => yahooAllowlist.includes(k.keyword));
        console.log(`[ScrapingService] YAHOO_KEYWORD_ALLOWLIST 適用: ${yahooKeywords.length}/${before}件に絞り込み (${yahooKeywords.map(k=>k.keyword).join(', ')})`);
      }

      const concMercari = parseInt(process.env.SCRAPING_CONCURRENCY_MERCARI) || 3;
      const concYahoo   = parseInt(process.env.SCRAPING_CONCURRENCY_YAHOO)   || 2;

      const mercariTasks = mercariKeywords.map(kw => async () => {
        const items = await this.mercariScraper.search(kw.keyword);
        await this._processItems(items, kw, scanState, cap);
        return items.length;
      });

      const yahooTasks = yahooKeywords.map(kw => async () => {
        // サーキットブレーカー: 本スキャン中に既に429検出済みなら即スキップ
        if (scanState.yahooRateLimited) return 0;
        try {
          const items = await this.yahooScraper.search(kw.keyword);
          // 並列レースで search 中に別ワーカーが429検出した場合の追加ガード
          if (scanState.yahooRateLimited) return 0;
          await this._processItems(items, kw, scanState, cap);
          return items.length;
        } catch (err) {
          if (err && err.name === 'YahooRateLimitError') {
            if (!scanState.yahooRateLimited) {
              console.warn('[YahooScraper] 429検出、本スキャンの残りYahooキーワードをスキップ');
              scanState.yahooRateLimited = true;
            }
            return 0;
          }
          throw err;
        }
      });

      await Promise.all([
        this._runWithConcurrency(mercariTasks, concMercari),
        this._runWithConcurrency(yahooTasks, concYahoo)
      ]);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const capMsg = scanState.capHitLogged ? ` / キャップ抑制: ${scanState.cappedCount}件` : '';
      console.log(`[ScrapingService] スキャン完了: ${elapsed}秒 / 通知: ${this.stats.notified}件 / フィルタ除外: ${this.stats.filtered}件${capMsg}`);
      this.lastRunAt = new Date();

    } catch (err) {
      console.error('[ScrapingService] スキャンエラー:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  async _processItems(items, keyword, scanState, cap) {
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

      // 6. 通知キャップチェック（1スキャン全体で NOTIFY_CAP_PER_SCAN 件まで）
      //    DetectedItem は既に notified=false で登録済み。
      //    キャップ超過分は notified=false のまま残す → 次回スキャンで既存判定に引っかかるので
      //    通知は永遠に来ないが、スパム防止を優先する仕様
      if (cap > 0 && scanState.notifyCount >= cap) {
        if (!scanState.capHitLogged) {
          console.log(`[ScrapingService] 通知キャップ到達（${cap}件）残りの通知をスキップ`);
          scanState.capHitLogged = true;
        }
        scanState.cappedCount++;
        this.stats.capped++;
        continue;
      }

      // 7. 通知（NotificationServiceがLINE/Telegramを内部で判定）
      await this.notification.notifyNewItem(item, keyword, product);
      await detected.update({ notified: true, notifiedAt: new Date() });
      scanState.notifyCount++;
      this.stats.notified++;
    }
  }
}

module.exports = ScrapingService;
