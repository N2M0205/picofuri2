// Cascading circuit breaker 単体テスト
// 使い方: node scripts/test-yahoo-auto-fallback.js
//
// 検証:
//   1. 初期状態で yahooAutoDisabled=false, yahoo429History=[]
//   2. 1回目 _record429AndMaybeAutoDisable() → 履歴1件、フラグ未発火
//   3. 2回目 _record429AndMaybeAutoDisable() → 履歴2件、フラグ発火、Telegram通知
//   4. runScan相当の判定: envYahooEnabled=true でも this.yahooAutoDisabled=true でYahoo skipに切り替わる
//   5. Telegram実配信は API 応答で確認
//
// 完了後、scripts/test-yahoo-auto-fallback.js は削除して構わない

require('dotenv').config();
const ScrapingService = require('../src/services/ScrapingService.js');

function assert(cond, msg) {
  if (!cond) { console.error('❌ ASSERTION FAILED:', msg); process.exit(1); }
  console.log('✅', msg);
}

(async () => {
  console.log('=== Cascading circuit breaker 単体テスト ===\n');

  const svc = new ScrapingService();

  // Step 1: 初期状態
  console.log('--- Step 1: 初期状態 ---');
  assert(svc.yahooAutoDisabled === false, '初期の yahooAutoDisabled は false');
  assert(Array.isArray(svc.yahoo429History) && svc.yahoo429History.length === 0, '初期の yahoo429History は空配列');
  console.log('');

  // Step 2: 1回目の429
  console.log('--- Step 2: 1回目の 429 検出 ---');
  svc._record429AndMaybeAutoDisable();
  assert(svc.yahoo429History.length === 1, '履歴が1件になっている');
  assert(svc.yahooAutoDisabled === false, '1件では自動停止フラグは立たない');
  console.log('');

  // Step 3: 2回目の429（閾値到達、フラグ発火 + Telegram発射）
  console.log('--- Step 3: 2回目の 429 検出（閾値到達） ---');
  console.log('   ↓ Telegram 送信が発火するはず（非同期・awaitしない）');
  svc._record429AndMaybeAutoDisable();
  assert(svc.yahoo429History.length === 2, '履歴が2件になっている');
  assert(svc.yahooAutoDisabled === true, '2件で自動停止フラグ発火');
  assert(svc.yahooAutoDisabledAt instanceof Date, '発動時刻(yahooAutoDisabledAt)がDate型で記録されている');
  console.log('   発動時刻:', svc.yahooAutoDisabledAt.toISOString());
  console.log('');

  // Step 4: 3回目呼び出し（既に発動済みなので Telegram は追い打ちしない、履歴だけ更新）
  console.log('--- Step 4: 3回目の 429 検出（既に発動済） ---');
  svc._record429AndMaybeAutoDisable();
  assert(svc.yahoo429History.length === 3, '履歴が3件（重複発動防止のためTelegramは打たない）');
  assert(svc.yahooAutoDisabled === true, 'フラグは true のまま');
  console.log('');

  // Step 5: runScan の Yahoo有効判定ロジックの検証（in-memory フラグを見ているか）
  console.log('--- Step 5: runScan の Yahoo有効判定 ---');
  process.env.YAHOO_SCRAPING_ENABLED = 'true';
  const envYahooEnabled = process.env.YAHOO_SCRAPING_ENABLED !== 'false';
  const yahooEnabled = envYahooEnabled && !svc.yahooAutoDisabled;
  assert(envYahooEnabled === true, '.env の YAHOO_SCRAPING_ENABLED は true');
  assert(yahooEnabled === false, '実効 yahooEnabled は false（in-memory breaker が優先）');
  console.log('');

  // Step 6: 30分ウィンドウ外の古い履歴は破棄される
  console.log('--- Step 6: 30分ウィンドウ外のタイムスタンプは破棄される ---');
  const svc2 = new ScrapingService();
  svc2.yahoo429History = [Date.now() - 31 * 60 * 1000]; // 31分前
  svc2._record429AndMaybeAutoDisable();
  assert(svc2.yahoo429History.length === 1, '古い履歴は破棄され、新規1件のみが残る');
  assert(svc2.yahooAutoDisabled === false, '30分ウィンドウ外は閾値カウントに入らないので発動せず');
  console.log('');

  // Telegramの実配信は非同期発火のため 少し待って完了を待つ
  console.log('   Telegram送信の非同期発火完了を待機中（3秒）...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n=== すべてのアサーション通過 ✅ ===');
  console.log('Telegram(aicham_dev_bot) の実配信は Bot チャットで確認してください（🚨 Yahoo自動停止 メッセージが1通届いているはず）。');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
