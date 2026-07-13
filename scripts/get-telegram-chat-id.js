#!/usr/bin/env node
// picofuri2_bot の getUpdates API を叩いて chat_id を確認する一時スクリプト。
//
// 使い方 (2 段階):
//   ① 新しく通知先に加えたい人に picofuri2_bot 宛てへ **何でもよいので1通** 送ってもらう
//      (例: "/start" または任意のテキスト)。既存の bot なのでスタートコマンドは
//      特に反応しなくても構わない。Bot はユーザーからのメッセージを updates に貯める
//   ② その直後にこのスクリプトを実行:
//        node scripts/get-telegram-chat-id.js
//      出力例:
//        [1] chat_id=123456789  from=@example / John Doe
//            text="/start"
//        [2] chat_id=987654321  from=... 既存オーナー
//      新規登録するべき chat_id はまだ .env に載っていないもの (getUpdates は
//      直近数十件の更新を返す)
//
// 補足:
//   - この getUpdates 呼び出しは webhook を使っていない前提。picofuri2 は
//     webhook 未使用のため通常通り使える
//   - Telegram API は getUpdates を「未処理更新のあるボット」でしか返さない。
//     もしメッセージ後に呼んでも空配列なら、Bot 側で既に更新をポーリング
//     消化した可能性 → 新しいメッセージを送ってもらって再度実行
//   - 実行後、確定した chat_id は .env の TELEGRAM_CHAT_IDS
//     (カンマ区切り) に追加する。詳細は本ブランチの README 参照
//
// このスクリプトは chat_id 確認用の一時ツール。運用完了後に削除しても構わない。

'use strict';

require('dotenv').config();
const axios = require('axios');

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'REPLACE_ME' || token.length < 20) {
    console.error('ERROR: .env の TELEGRAM_BOT_TOKEN が設定されていません');
    process.exit(1);
  }

  const url = `https://api.telegram.org/bot${token}/getUpdates`;
  let res;
  try {
    res = await axios.get(url, { timeout: 10000 });
  } catch (e) {
    console.error('getUpdates 呼び出し失敗:', e.response?.status, e.message);
    if (e.response?.data) console.error(JSON.stringify(e.response.data));
    process.exit(1);
  }

  if (!res.data || !res.data.ok) {
    console.error('Telegram API が ok=false を返しました:');
    console.error(JSON.stringify(res.data, null, 2));
    process.exit(1);
  }

  const updates = res.data.result || [];
  if (updates.length === 0) {
    console.log('更新はゼロ件でした。');
    console.log('→ 新しく通知先に加えたい人に picofuri2_bot 宛てへ');
    console.log('  1通メッセージを送ってもらってから、このスクリプトを再実行してください。');
    return;
  }

  console.log(`=== getUpdates 結果 (${updates.length}件) ===`);
  const seenChats = new Map();
  updates.forEach((u, i) => {
    const msg = u.message || u.edited_message || u.channel_post || {};
    const chat = msg.chat || {};
    const from = msg.from || {};
    const chatId = chat.id;
    const label = [
      from.username ? '@' + from.username : null,
      [from.first_name, from.last_name].filter(Boolean).join(' ')
    ].filter(Boolean).join(' / ') || '(unknown)';
    const text = (msg.text || '').slice(0, 60);
    console.log(`[${i + 1}] chat_id=${chatId}  from=${label}`);
    console.log(`    text="${text}"  chat.type=${chat.type}`);
    if (chatId != null) seenChats.set(String(chatId), label);
  });

  console.log(`\n=== ユニーク chat_id (${seenChats.size}件) ===`);
  const currentIds = new Set(
    (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_ADMIN_ID || '')
      .split(',').map(s => s.trim()).filter(Boolean)
  );
  for (const [cid, label] of seenChats.entries()) {
    const already = currentIds.has(cid) ? ' (登録済み)' : ' ← 新規候補';
    console.log(`  ${cid}${already}  ${label}`);
  }
  console.log('\n新規 chat_id を .env の TELEGRAM_CHAT_IDS にカンマ区切りで追加してください');
  console.log('例: TELEGRAM_CHAT_IDS=8656466812,<新しいID>');
}

main().catch(e => { console.error(e); process.exit(1); });
