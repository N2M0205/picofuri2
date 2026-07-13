require('dotenv').config();
const cron = require('node-cron');
const express = require('express');
const { initDB } = require('./models/index.js');
const ScrapingService = require('./services/ScrapingService.js');
const CrossmallService = require('./services/CrossmallService.js');

async function main() {
  console.log('=== ピコフリ2 起動中 ===');

  await initDB();

  const scraping = new ScrapingService();
  await scraping.initialize();

  const crossmall = new CrossmallService();

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
  cron.schedule(cronForMin(hotMin), () => scraping.runScan({ tier: 'hot' }));
  cron.schedule(cronForMin(warmMin), () => scraping.runScan({ tier: 'warm' }));
  cron.schedule(cronForMin(coldMin), () => scraping.runScan({ tier: 'cold' }));
  cron.schedule(cronForMin(starredOosMin), () => scraping.runScan({ tier: 'starredOos' }));

  // CROSSMALL同期（2時間ごと: 注文蓄積 + 在庫 + 商品情報）
  cron.schedule('0 */2 * * *', () => crossmall.syncAll());

  // 日次ヘルスチェック (毎朝9時 JST): Yahoo 実質稼働状態を Telegram に通知。
  // breaker 発動見落とし事故 (2026-07-13 の 11.5h 停止) への対策。
  cron.schedule('0 9 * * *', () => {
    scraping.sendDailyHealthCheck().catch(e =>
      console.error('[daily-health-check] エラー:', e.message)
    );
  }, { timezone: 'Asia/Tokyo' });

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
