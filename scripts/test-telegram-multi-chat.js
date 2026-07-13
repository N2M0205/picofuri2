#!/usr/bin/env node
// NotificationService.sendTelegram の複数chat_id対応テスト。
// axios.post をモック化して実 Telegram 送信せずに 6 ケース検証。
//
// 使い方: node scripts/test-telegram-multi-chat.js

'use strict';

// axios モックを差し替えてから NotificationService を require
const axios = require('axios');
let posted = [];
let failNext = new Map(); // chat_id → true でその chat_id の send を落とす
axios.post = async (url, body) => {
  if (failNext.get(String(body.chat_id))) {
    const err = new Error('mock failure');
    err.response = { status: 400 };
    throw err;
  }
  posted.push({ url, chat_id: String(body.chat_id), text: body.text });
  return { data: { ok: true } };
};

const NotificationService = require('../src/services/NotificationService');

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

async function withEnv(env, fn) {
  const orig = {};
  for (const k of Object.keys(env)) {
    orig[k] = process.env[k];
    if (env[k] === null) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { await fn(); }
  finally {
    for (const k of Object.keys(env)) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
}

async function main() {
  console.log('[test-1] _parseChatIds: TELEGRAM_CHAT_IDS 優先');
  const ids1 = NotificationService._parseChatIds('111,222 , 333', '999');
  assert(JSON.stringify(ids1) === JSON.stringify(['111','222','333']), 'CSV パース (空白除去)');

  console.log('\n[test-2] _parseChatIds: CSV が空なら ADMIN_ID にフォールバック (後方互換)');
  const ids2 = NotificationService._parseChatIds('', '999');
  assert(JSON.stringify(ids2) === JSON.stringify(['999']), 'ADMIN_ID 単一 fallback');
  const ids3 = NotificationService._parseChatIds(undefined, '999');
  assert(JSON.stringify(ids3) === JSON.stringify(['999']), 'undefined でも fallback');
  const ids4 = NotificationService._parseChatIds(null, null);
  assert(ids4.length === 0, '両方無しなら空配列');

  console.log('\n[test-3] 複数 chat_id: 両方に送信される');
  await withEnv({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_IDS: '111,222',
    TELEGRAM_ADMIN_ID: null,
    TELEGRAM_NOTIFY_ENABLED: 'true',
  }, async () => {
    posted = []; failNext.clear();
    const svc = new NotificationService();
    await svc.sendTelegram('hello');
    assert(posted.length === 2, `2件送信 (実測 ${posted.length})`);
    const chatIds = posted.map(p => p.chat_id);
    assert(chatIds.includes('111') && chatIds.includes('222'), '111 と 222 の両方に送信');
    assert(posted.every(p => p.text === 'hello'), '両方に同じテキスト');
  });

  console.log('\n[test-4] 単一 chat_id (旧 TELEGRAM_ADMIN_ID) で従来動作');
  await withEnv({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_IDS: null,
    TELEGRAM_ADMIN_ID: '999',
    TELEGRAM_NOTIFY_ENABLED: 'true',
  }, async () => {
    posted = []; failNext.clear();
    const svc = new NotificationService();
    await svc.sendTelegram('legacy');
    assert(posted.length === 1, '1件送信 (回帰チェック)');
    assert(posted[0].chat_id === '999', 'ADMIN_ID=999 に送信');
    assert(posted[0].text === 'legacy', 'テキスト一致');
  });

  console.log('\n[test-5] 片方の chat_id が失敗 → 他方は継続');
  await withEnv({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_IDS: '111,222',
    TELEGRAM_NOTIFY_ENABLED: 'true',
  }, async () => {
    posted = []; failNext.clear();
    failNext.set('111', true);  // 111 で失敗する
    const svc = new NotificationService();
    await svc.sendTelegram('recovery-test');
    // 111 で例外、222 に届く
    assert(posted.length === 1, `222 のみ受信 (実測 ${posted.length})`);
    assert(posted[0].chat_id === '222', '222 に到達');
  });

  console.log('\n[test-6] 長文分割: 各 chat_id にチャンク数だけ送信');
  await withEnv({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_IDS: '111,222',
    TELEGRAM_NOTIFY_ENABLED: 'true',
  }, async () => {
    posted = []; failNext.clear();
    const svc = new NotificationService();
    const longMsg = 'A'.repeat(9000); // 4000ずつなので 3チャンク
    await svc.sendTelegram(longMsg);
    // 2 chat × 3 chunk = 6
    assert(posted.length === 6, `2 chat × 3 chunk = 6 送信 (実測 ${posted.length})`);
    const per111 = posted.filter(p => p.chat_id === '111').length;
    const per222 = posted.filter(p => p.chat_id === '222').length;
    assert(per111 === 3 && per222 === 3, `各 chat で 3チャンク (111=${per111} 222=${per222})`);
  });

  console.log('\n[test-7] TELEGRAM_NOTIFY_ENABLED=false: 送信スキップ');
  await withEnv({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_IDS: '111,222',
    TELEGRAM_NOTIFY_ENABLED: 'false',
  }, async () => {
    posted = []; failNext.clear();
    const svc = new NotificationService();
    await svc.sendTelegram('should not send');
    assert(posted.length === 0, 'enabled=false で送信ゼロ');
  });

  console.log('\n[test-8] chat_id 全滅で新規登録なしなら送信スキップ');
  await withEnv({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_IDS: null,
    TELEGRAM_ADMIN_ID: null,
    TELEGRAM_NOTIFY_ENABLED: 'true',
  }, async () => {
    posted = []; failNext.clear();
    const svc = new NotificationService();
    await svc.sendTelegram('nowhere');
    assert(posted.length === 0, 'chat_id なしで送信ゼロ');
  });

  console.log('\n=== テスト結果 ===');
  if (process.exitCode) console.error('FAILED');
  else console.log('ALL PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
