#!/usr/bin/env node
// feat/yahoo-breaker-reminder のオフラインテスト。
// - Telegram POST を axios.post のモックで捕捉し、実送信はしない
// - YAHOO_BREAKER_REMINDER_MS=3000 でタイムアウトを 3秒に短縮
// - 疑似 429 を 2 回発生 → breaker 発動 → 3 秒後にリマインダーが飛ぶことを確認
// - sendDailyHealthCheck() の 2 通り (通常/停止中) メッセージを検証
//
// 使い方:
//   node scripts/test-yahoo-breaker-reminder.js
//   (env: YAHOO_BREAKER_REMINDER_MS=3000 が内部で設定される)

'use strict';

process.env.YAHOO_BREAKER_REMINDER_MS = '3000';
// axios.post をモック化 (require キャッシュより先に差し替え)
const axios = require('axios');
const captured = [];
axios.post = async (url, body) => {
  captured.push({ url, body });
  return { data: { ok: true } };
};

const ScrapingService = require('../src/services/ScrapingService.js');

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const s = new ScrapingService();

  console.log('[test-1] 初期状態: yahooAutoDisabled=false / _breakerReminderTimer=null');
  assert(s.yahooAutoDisabled === false, 'yahooAutoDisabled 初期値 false');
  assert(s._breakerReminderTimer === null, 'reminder timer 初期値 null');

  console.log('\n[test-2] 疑似 429 を 1 回 → まだ breaker 発動しない (閾値 2)');
  s._record429AndMaybeAutoDisable();
  assert(s.yahooAutoDisabled === false, '1回では breaker 未発動');
  assert(captured.length === 0, 'Telegram 送信ゼロ');

  console.log('\n[test-3] 疑似 429 を 2 回目 → breaker 発動 & 初回通知');
  s._record429AndMaybeAutoDisable();
  assert(s.yahooAutoDisabled === true, 'breaker 発動');
  assert(s.yahooAutoDisabledAt instanceof Date, 'yahooAutoDisabledAt が Date');
  assert(captured.length === 1, 'Telegram 初回通知が 1 件');
  const initialText = captured[0]?.body?.text || '';
  assert(initialText.includes('🚨 Yahoo自動停止'), '初回テキストに 🚨 Yahoo自動停止 が含まれる');
  assert(s._breakerReminderTimer !== null, 'reminder timer が仕込まれている');

  console.log('\n[test-4] 二重発火防止: 既に発動済みで再度 _record429... を呼んでもタイマー重複しない');
  const timerBefore = s._breakerReminderTimer;
  s._record429AndMaybeAutoDisable();
  assert(s._breakerReminderTimer === timerBefore, 'reminder timer は同一のまま');
  assert(captured.length === 1, 'Telegram 通知が増えていない');

  console.log('\n[test-5] 3秒待機 → リマインダー通知が飛ぶ (YAHOO_BREAKER_REMINDER_MS=3000)');
  await sleep(3500);
  assert(captured.length === 2, 'Telegram 通知が 2 件目まで来ている');
  const reminderText = captured[1]?.body?.text || '';
  assert(reminderText.includes('⏰ Yahoo自動停止が継続中'), 'リマインダーテキストに ⏰ 継続中 が含まれる');
  assert(reminderText.includes('pm2 restart'), 'リマインダーに pm2 restart が含まれる');

  console.log('\n[test-6] 復旧シナリオ: yahooAutoDisabled=false にしてから再度 breaker 発動、pm2 restart 前提でリマインダーは飛ばない');
  // reset
  s.yahooAutoDisabled = false;
  s.yahooAutoDisabledAt = null;
  s._breakerReminderTimer = null;
  s.yahoo429History = [];
  captured.length = 0;
  // 429 x 2 → 発動
  s._record429AndMaybeAutoDisable();
  s._record429AndMaybeAutoDisable();
  assert(s.yahooAutoDisabled === true, '再度 breaker 発動');
  assert(captured.length === 1, '初回通知 1件');
  // pm2 restart 相当: フラグを手動で戻す
  s.yahooAutoDisabled = false;
  await sleep(3500);
  assert(captured.length === 1, 'yahooAutoDisabled=false 状態ではリマインダー飛ばず (1件のまま)');

  console.log('\n[test-7] sendDailyHealthCheck: 正常稼働時 → ☀️');
  s.yahooAutoDisabled = false;
  process.env.YAHOO_SCRAPING_ENABLED = 'true';
  captured.length = 0;
  const okText = await s.sendDailyHealthCheck();
  assert(okText.includes('☀️'), '正常稼働時: ☀️ が含まれる');
  assert(okText.includes('正常稼働中'), '「正常稼働中」が含まれる');
  assert(captured.length === 1, 'Telegram 送信 1件');

  console.log('\n[test-8] sendDailyHealthCheck: breaker 発動中 → ⚠️');
  s.yahooAutoDisabled = true;
  s.yahooAutoDisabledAt = new Date();
  captured.length = 0;
  const ngText = await s.sendDailyHealthCheck();
  assert(ngText.includes('⚠️'), '停止中: ⚠️ が含まれる');
  assert(ngText.includes('停止中'), '「停止中」が含まれる');
  assert(ngText.includes('cascading breaker'), 'breaker 発動理由が含まれる');

  console.log('\n[test-9] sendDailyHealthCheck: YAHOO_SCRAPING_ENABLED=false → ⚠️');
  s.yahooAutoDisabled = false;
  process.env.YAHOO_SCRAPING_ENABLED = 'false';
  captured.length = 0;
  const envOffText = await s.sendDailyHealthCheck();
  assert(envOffText.includes('⚠️'), '.env off: ⚠️ が含まれる');
  assert(envOffText.includes('YAHOO_SCRAPING_ENABLED=false'), '理由に env 名が含まれる');

  // restore env for後続処理
  process.env.YAHOO_SCRAPING_ENABLED = 'true';

  console.log('\n=== テスト結果 ===');
  if (process.exitCode) console.error('FAILED');
  else console.log('ALL PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
