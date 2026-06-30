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

  const intervalSec = parseInt(process.env.SCRAPING_INTERVAL_SECONDS) || 60;
  console.log(`[Scheduler] スキャン間隔: ${intervalSec}秒`);

  // 起動時に CROSSMALL 注文蓄積を1回実行（バックグラウンド、長時間ジョブ）
  setTimeout(() => {
    crossmall.syncOrders().catch(e => console.error('[起動時syncOrders] エラー:', e.message));
  }, 10000);

  // 起動時に即1回スキャン（CROSSMALL情報なしでも参考通知は出る）
  setTimeout(() => scraping.runScan(), 5000);

  // 定期スキャン（node-cron: 最小1分間隔。60秒未満はsetInterval）
  if (intervalSec < 60) {
    setInterval(() => scraping.runScan(), intervalSec * 1000);
  } else {
    cron.schedule(`*/${Math.floor(intervalSec / 60)} * * * *`, () => scraping.runScan());
  }

  // CROSSMALL同期（2時間ごと: 注文蓄積 + 在庫 + 商品情報）
  cron.schedule('0 */2 * * *', () => crossmall.syncAll());

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
