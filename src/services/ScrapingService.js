const { Keyword, DetectedItem, CrossmallProduct } = require('../models/index.js');
const MercariApiScraper = require('../scrapers/MercariApiScraper.js');
const YahooScraper = require('../scrapers/YahooScraper.js');
const CrossmallService = require('./CrossmallService.js');
const NotificationService = require('./NotificationService.js');
const FilterService = require('./FilterService.js');
const TierClassifier = require('./TierClassifier.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

// Cascading circuit breaker 閾値: 直近30分に 2回以上の429検出で自動Yahoo停止
const YAHOO_429_WINDOW_MS = 30 * 60 * 1000;
const YAHOO_429_THRESHOLD = 2;
// breaker 発動から N ms 後、まだ停止中ならリマインダー再送 (テストで短縮可)
const YAHOO_BREAKER_REMINDER_MS =
  parseInt(process.env.YAHOO_BREAKER_REMINDER_MS, 10) || (30 * 60 * 1000);

class ScrapingService {
  constructor() {
    this.mercariScraper = new MercariApiScraper();
    this.yahooScraper = new YahooScraper();
    this.crossmall = new CrossmallService();
    this.notification = new NotificationService();
    this.filter = new FilterService();
    // 階層別のスキャン中フラグ (Hot/Warm/Cold/StarredOos は独立、'all' は tier 指定なしの後方互換用)
    this.isRunningByTier = { hot: false, warm: false, cold: false, starredOos: false, all: false };
    this.lastRunAt = null;
    this.lastRunAtByTier = { hot: null, warm: null, cold: null, starredOos: null, all: null };
    this.stats = { success: 0, error: 0, notified: 0, filtered: 0, capped: 0 };
    // Cascading breaker: in-memory の429タイムスタンプ履歴と自動停止フラグ
    // プロセス再起動でリセットされる（.env自体は書き換えない）
    this.yahoo429History = [];
    this.yahooAutoDisabled = false;
    this.yahooAutoDisabledAt = null;
    // breaker 発動時に仕込むリマインダー setTimeout ハンドル (重複防止・停止用)
    this._breakerReminderTimer = null;
  }

  // 429検出時に呼ぶ。ウィンドウ内の件数を確認し閾値到達なら自動停止&Telegram通知。
  _record429AndMaybeAutoDisable() {
    const now = Date.now();
    // 古いタイムスタンプを除去してから新規追加
    this.yahoo429History = this.yahoo429History.filter(t => now - t < YAHOO_429_WINDOW_MS);
    this.yahoo429History.push(now);

    if (this.yahoo429History.length >= YAHOO_429_THRESHOLD && !this.yahooAutoDisabled) {
      this.yahooAutoDisabled = true;
      this.yahooAutoDisabledAt = new Date();
      const msg = '🚨 Yahoo自動停止: 429が直近30分に2回以上検出されたため自動停止しました。復旧するには .env の YAHOO_SCRAPING_ENABLED を確認してください';
      console.error(`[ScrapingService] ${msg}`);
      // Telegram通知は非同期発火（awaitしない、失敗しても運用継続）
      this._sendYahooAutoDisableNotification(msg);
      this._scheduleBreakerReminder();
    }
  }

  // breaker 発動から YAHOO_BREAKER_REMINDER_MS 後、まだ停止中ならリマインダー再送。
  // pm2 restart 等で復旧している場合 (yahooAutoDisabled=false) は何もしない。
  // 二重仕込み防止: 既にタイマーが走っていれば新規予約しない。
  _scheduleBreakerReminder() {
    if (this._breakerReminderTimer) return;
    this._breakerReminderTimer = setTimeout(() => {
      this._breakerReminderTimer = null;
      if (!this.yahooAutoDisabled) return;
      const disabledAt = this.yahooAutoDisabledAt?.toISOString?.() || '不明';
      const minutes = Math.round(YAHOO_BREAKER_REMINDER_MS / 60000);
      const text = `⏰ Yahoo自動停止が継続中です（発動から${minutes}分経過）。復旧するには pm2 restart が必要です（発動時刻: ${disabledAt}）`;
      console.error(`[ScrapingService] ${text}`);
      this._sendYahooAutoDisableNotification(text);
    }, YAHOO_BREAKER_REMINDER_MS);
    // Node.js プロセス終了をブロックしないよう unref
    if (typeof this._breakerReminderTimer.unref === 'function') this._breakerReminderTimer.unref();
  }

  // 運用系通知 (breaker発動 / 30分後リマインダー / 日次ヘルスチェック) を
  // 2 経路に配信する:
  //   ① Claude 監視 bot (~/.claude-notify.env、既存)
  //   ② picofuri2_bot の owner 単独 (chat_id=8656466812、新設)
  // 意図的に TELEGRAM_CHAT_IDS は使わず owner のみ hardcode。仕入通知先の
  // koba (5971882796) への運用通知漏れを構造的に防ぐため。
  // 片方の失敗は他方に影響させない (二重送信で到達確実性優先)。
  async _sendYahooAutoDisableNotification(text) {
    await this._sendViaClaudeNotifyBot(text);
    await this._sendViaPicofuriBotOwner(text);
  }

  async _sendViaClaudeNotifyBot(text) {
    try {
      const credPath = path.join(os.homedir(), '.claude-notify.env');
      if (!fs.existsSync(credPath)) {
        console.warn('[ScrapingService] ~/.claude-notify.env 不在、Claude bot 通知スキップ');
        return;
      }
      const content = fs.readFileSync(credPath, 'utf-8');
      const tokenMatch = content.match(/CLAUDE_NOTIFY_BOT_TOKEN=([^\n\r]+)/);
      const chatMatch  = content.match(/CLAUDE_NOTIFY_CHAT_ID=([^\n\r]+)/);
      if (!tokenMatch || !chatMatch) {
        console.warn('[ScrapingService] .claude-notify.env の資格情報不備、Claude bot 通知スキップ');
        return;
      }
      await axios.post(
        `https://api.telegram.org/bot${tokenMatch[1].trim()}/sendMessage`,
        { chat_id: chatMatch[1].trim(), text },
        { timeout: 10000 }
      );
    } catch (e) {
      console.error('[ScrapingService] Claude bot 通知エラー:', e.message);
    }
  }

  async _sendViaPicofuriBotOwner(text) {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        console.warn('[ScrapingService] TELEGRAM_BOT_TOKEN 未設定、picofuri2_bot 通知スキップ');
        return;
      }
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id: '8656466812', text },
        { timeout: 10000 }
      );
    } catch (e) {
      console.error('[ScrapingService] picofuri2_bot 通知エラー:', e.message);
    }
  }

  // 日次ヘルスチェック: Yahoo 実質稼働状態を Telegram に 1行送信。
  // 実質稼働 = YAHOO_SCRAPING_ENABLED=true かつ in-memory yahooAutoDisabled=false。
  // どちらか false なら停止中と扱う。
  async sendDailyHealthCheck() {
    const envEnabled = process.env.YAHOO_SCRAPING_ENABLED !== 'false';
    const running = envEnabled && !this.yahooAutoDisabled;
    let text;
    if (running) {
      text = '☀️ 朝の稼働確認: Yahoo正常稼働中';
    } else {
      const reasons = [];
      if (!envEnabled) reasons.push('YAHOO_SCRAPING_ENABLED=false');
      if (this.yahooAutoDisabled) {
        const at = this.yahooAutoDisabledAt?.toISOString?.() || '不明';
        reasons.push(`cascading breaker発動中 (${at})`);
      }
      text = `⚠️ 朝の稼働確認: Yahoo停止中（要restart） — ${reasons.join(' / ')}`;
    }
    console.log(`[ScrapingService] ${text}`);
    await this._sendYahooAutoDisableNotification(text);
    return text;
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

  async runScan(options = {}) {
    // tier 指定: 'hot' | 'warm' | 'cold' | null (未指定=全件)
    // Hot/Warm/Cold の各階層で独立ロックし、Cold の長時間スキャン中でも Hot が並列可能。
    const tier = options.tier || null;
    const lockKey = tier || 'all';
    const tierLabel = tier ? `[${tier}]` : '[all]';

    if (this.isRunningByTier[lockKey]) {
      console.log(`[ScrapingService] ${tierLabel} 前回スキャン実行中のためスキップ`);
      return;
    }
    this.isRunningByTier[lockKey] = true;
    const startTime = Date.now();
    console.log(`[ScrapingService] スキャン開始 ${tierLabel}: ${new Date().toLocaleString('ja-JP')}`);

    // per-scan 状態はローカル変数に閉じ込めて、インスタンス変数のリセット漏れを構造的に排除する。
    // _processItems は並列実行されるためリアルタイムでカウンタ共有が必要 →
    // オブジェクトで包んで参照渡し（返り値集計だと並列中のキャップ判定に間に合わない）。
    // env はスキャン毎に読み直し、pm2 restart --update-env 反映を早める。
    // yahooRateLimited: 429検出時のサーキットブレーカー、残Yahooキーワードを全スキップ。
    const scanState = { notifyCount: 0, cappedCount: 0, capHitLogged: false, yahooRateLimited: false };
    const cap = parseInt(process.env.NOTIFY_CAP_PER_SCAN) || 0;

    // YAHOO_SCRAPING_ENABLED=false でYahooスキャン全体をスキップ（rate limit対策の運用フラグ）
    // 加えて、cascading circuit breaker (this.yahooAutoDisabled) が立っている場合も同様にスキップ
    const envYahooEnabled = process.env.YAHOO_SCRAPING_ENABLED !== 'false';
    const yahooEnabled = envYahooEnabled && !this.yahooAutoDisabled;
    // YAHOO_KEYWORD_ALLOWLIST=カンマ区切りキーワード名 で Yahoo対象を絞り込む（段階的再開の検証用）
    // 空文字/未設定なら絞り込みなし（全 yahoo_flea キーワードが対象）
    const yahooAllowlist = (process.env.YAHOO_KEYWORD_ALLOWLIST || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    try {
      let keywords = await Keyword.findAll({ where: { isActive: true } });

      // 階層フィルタ適用 (tier 指定時のみ、指定なしは全件)
      // 分類は毎スキャン時に最新の CrossmallProduct を基に行う (stock/sales28 の変動を即反映)
      if (tier) {
        const classes = await TierClassifier.classifyAll();
        const kwIds = new Set((classes[tier] || []).map(k => k.id));
        const before = keywords.length;
        keywords = keywords.filter(k => kwIds.has(k.id));
        console.log(`[ScrapingService] ${tierLabel} 階層フィルタ: ${keywords.length}/${before}件 ` +
          `(hot=${classes.hot.length} warm=${classes.warm.length} cold=${classes.cold.length} starredOos=${(classes.starredOos || []).length})`);
      }

      const mercariKeywords = keywords.filter(k => k.platforms.includes('mercari'));
      let yahooKeywords = yahooEnabled ? keywords.filter(k => k.platforms.includes('yahoo_flea')) : [];

      if (!yahooEnabled) {
        if (this.yahooAutoDisabled) {
          console.warn(`[ScrapingService] Yahoo自動停止中（cascading breaker発動 ${this.yahooAutoDisabledAt?.toISOString()}、プロセス再起動でリセット）`);
        } else {
          console.log('[ScrapingService] YAHOO_SCRAPING_ENABLED=false: Yahoo!フリマスキャン全体をスキップ');
        }
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
            // Cascading breaker: 直近30分の429件数を追跡、閾値到達で自動停止&Telegram通知
            this._record429AndMaybeAutoDisable();
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
      console.log(`[ScrapingService] スキャン完了 ${tierLabel}: ${elapsed}秒 / 通知: ${this.stats.notified}件 / フィルタ除外: ${this.stats.filtered}件${capMsg}`);
      this.lastRunAt = new Date();
      this.lastRunAtByTier[lockKey] = this.lastRunAt;

    } catch (err) {
      console.error(`[ScrapingService] スキャンエラー ${tierLabel}:`, err.message);
    } finally {
      this.isRunningByTier[lockKey] = false;
    }
  }

  async _processItems(items, keyword, scanState, cap) {
    // 当該キーワードに紐づく CrossmallProduct を事前取得
    // n派生コード（末尾"n"、複数カタログ）にのみ売上が集約されているケースへの
    // 局所フォールバック: base 側 sales28=0 のとき n派生の sales/last* を採用する。
    // stock は base 側を維持（n派生は stock=0 のことが多く在庫日数計算が壊れるため）
    let product = await this._resolveProduct(keyword);

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

  // keyword.crossmallItemCode から通知用 product を返す。
  // n派生に売上が集約されている場合は base(stock) + n(sales/last*) をマージする。
  async _resolveProduct(keyword) {
    if (!keyword.crossmallItemCode) {
      try { return await this.crossmall.findProductByKeyword(keyword); }
      catch { return null; }
    }

    const code = keyword.crossmallItemCode;
    const base = await CrossmallProduct.findOne({ where: { itemCode: code } });
    const nCode = code.endsWith('n') ? null : code + 'n';
    const nVariant = nCode
      ? await CrossmallProduct.findOne({ where: { itemCode: nCode } })
      : null;

    const baseSales28 = base?.sales28 ?? 0;
    const nSales28 = nVariant?.sales28 ?? 0;
    const nSales7  = nVariant?.sales7  ?? 0;
    const useN = base && baseSales28 === 0 && (nSales28 > 0 || nSales7 > 0);

    if (useN) {
      console.log(`[ScrapingService] n派生フォールバック採用: keyword="${keyword.keyword}" base=${code}(stock=${base.stock}) n=${nCode}(s28=${nSales28} lsp=${nVariant.lastSalePrice})`);
      return {
        itemCode: base.itemCode,
        itemName: base.itemName,
        stock: base.stock,
        purchasePrice: base.purchasePrice,
        retailPrice: base.retailPrice,
        sales7: nVariant.sales7,
        sales14: nVariant.sales14,
        sales28: nVariant.sales28,
        lastSalePrice: nVariant.lastSalePrice,
        lastSaleDate: nVariant.lastSaleDate,
        deliveryType: nVariant.deliveryType,
        baseItemCode: base.baseItemCode,
        _source: 'merged(base+n)',
      };
    }

    if (base) return base;
    if (nVariant) return nVariant;

    try { return await this.crossmall.findProductByKeyword(keyword); }
    catch { return null; }
  }
}

module.exports = ScrapingService;
