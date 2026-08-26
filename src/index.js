require('dotenv').config();
const cron = require('node-cron');
const express = require('express');
const { initDB } = require('./models/index.js');
const ScrapingService = require('./services/ScrapingService.js');
const CrossmallService = require('./services/CrossmallService.js');
const {
  InventoryAlertService,
  evaluateAllSkus,
  renderDashboardHtml,
} = require('./services/InventoryAlertService.js');
const inventoryAlertConfig = require('./config/inventoryAlert.json');

async function main() {
  console.log('=== ピコフリ2 起動中 ===');

  await initDB();

  const scraping = new ScrapingService();
  await scraping.initialize();

  const crossmall = new CrossmallService();
  const inventoryAlert = new InventoryAlertService();
  // syncAll 完了直後に在庫アラート判定を連結呼び出し (2026-08-26 追加)
  //   → 「同期完了 → 最新データで判定 → 新規🔴あれば Telegram」の一連を 1 サイクルで実行
  //   フック内の例外は CrossmallService 側の try/catch で吸収される
  crossmall.onSyncComplete = () => inventoryAlert.runCheck();

  // 階層別スキャン間隔 (分単位、cron)。従来の SCRAPING_INTERVAL_SECONDS は廃止。
  const hotMin = parseInt(process.env.HOT_SCAN_INTERVAL_MINUTES) || 1;
  const warmMin = parseInt(process.env.WARM_SCAN_INTERVAL_MINUTES) || 5;
  const coldMin = parseInt(process.env.COLD_SCAN_INTERVAL_MINUTES) || 30;
  const starredOosMin = parseInt(process.env.STARRED_OOS_SCAN_INTERVAL_MINUTES) || 5;
  const cronForMin = (m) => (m === 1 ? '* * * * *' : `*/${m} * * * *`);
  console.log(`[Scheduler] Hot: 毎${hotMin}分、Warm: 毎${warmMin}分、Cold: 毎${coldMin}分、StarredOos: 毎${starredOosMin}分`);

  // 起動時: Hot/Warm/Cold/StarredOos を順次即実行 (バースト分散のため staggered start)
  setTimeout(() => scraping.runScan({ tier: 'hot' }), 10000);
  setTimeout(() => scraping.runScan({ tier: 'warm' }), 30000);
  setTimeout(() => scraping.runScan({ tier: 'starredOos' }), 45000);
  setTimeout(() => scraping.runScan({ tier: 'cold' }), 60000);

  // 起動時 CROSSMALL 同期は syncAll に統合（Phase2）:
  // - 初回起動時（CrossmallSale=0件）は syncOrders 内で 90日バックフィル
  // - 2回目以降は latest.orderDate - MARGIN_DAYS からの差分のみ
  // - syncAll 内は isSyncing フラグで並列起動を防止
  setTimeout(() => {
    crossmall.syncAll().catch(e => console.error('[起動時syncAll] エラー:', e.message));
  }, 90000);

  // 階層別定期スキャン (各 tier は独立ロック、Cold の長時間中でも Hot が並列可)
  // cron の :00 分ちょうどに複数 tier + CROSSMALL 同期が同時発火して Yahoo 429
  // を踏む問題 (2026-07-13 に24h内3発動) を緩和するため、Cold/Warm/StarredOos
  // に固定 jitter を導入する。Hot は毎分・軽量のため対象外。
  const jitterMs = { warm: 8000, cold: 15000, starredOos: 22000 };
  const scheduleWithJitter = (min, tier) => {
    cron.schedule(cronForMin(min), () => {
      setTimeout(() => scraping.runScan({ tier }), jitterMs[tier] || 0);
    });
  };
  cron.schedule(cronForMin(hotMin), () => scraping.runScan({ tier: 'hot' }));
  scheduleWithJitter(warmMin, 'warm');
  scheduleWithJitter(coldMin, 'cold');
  scheduleWithJitter(starredOosMin, 'starredOos');

  // CROSSMALL同期（2時間ごと: 注文蓄積 + 在庫 + 商品情報）
  cron.schedule('0 */2 * * *', () => crossmall.syncAll());

  // 日次ヘルスチェック (毎朝9時 JST): Yahoo 実質稼働状態を Telegram に通知。
  // breaker 発動見落とし事故 (2026-07-13 の 11.5h 停止) への対策。
  cron.schedule('0 9 * * *', () => {
    scraping.sendDailyHealthCheck().catch(e =>
      console.error('[daily-health-check] エラー:', e.message)
    );
  }, { timezone: 'Asia/Tokyo' });

  // 在庫アラート 8:00 定時ダイジェスト (2026-08-26 追加、feat/telegram-inventory-alert)
  // cron 表記と timezone は config/inventoryAlert.json で調整可
  cron.schedule(inventoryAlertConfig.digest_cron, () => {
    inventoryAlert.sendDailyDigest().catch(e =>
      console.error('[inventory-digest] エラー:', e.message)
    );
  }, { timezone: inventoryAlertConfig.digest_timezone });

  const app = express();
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      lastRunAt: scraping.lastRunAt,
      stats: scraping.stats,
      uptime: process.uptime()
    });
  });

  // 在庫アラートダッシュボード (2026-08-26 追加)
  // ?t=<token> パラメータで .env の INVENTORY_ALERT_TOKEN と照合、一致で HTML 返却、不一致は 403
  // ダッシュボードは毎リクエストでフレッシュに evaluateAllSkus() → キャッシュなし
  app.get(inventoryAlertConfig.dashboard_path, async (req, res) => {
    const expected = process.env[inventoryAlertConfig.dashboard_token_env];
    const given = req.query.t;
    // constant-time compare 回避のため、単純比較で十分 (token は開発者管理・低頻度)
    if (!expected || !given || expected !== given) {
      return res.status(403).type('text/plain').send('forbidden');
    }
    try {
      const results = await evaluateAllSkus(new Date());
      res.type('text/html').send(renderDashboardHtml(results, new Date()));
    } catch (e) {
      console.error('[inventory-dashboard] エラー:', e.message);
      res.status(500).type('text/plain').send('internal error');
    }
  });

  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log(`[API] http://localhost:${port}/health`));

  console.log('=== ピコフリ2 起動完了 ===');
}

main().catch(err => {
  console.error('起動エラー:', err);
  process.exit(1);
});
