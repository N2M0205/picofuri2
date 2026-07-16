#!/usr/bin/env node
// DEPRECATED 2026-07-16: Notionへ移行済み。report-to-notion.js参照
// (Google Docs「picofuri2 logs」がファイルサイズ超過でチャット読み取り不可となったため)
// scripts/report-to-docs.js
// 長文の実装結果・調査レポートを Google Docs に追記し、Telegram にリンク+要約を通知する。
//
// Usage:
//   node scripts/report-to-docs.js "<title>" <body-file>
//   node scripts/report-to-docs.js "<title>" -                # body from stdin
//   node scripts/report-to-docs.js "<title>" < body.md        # body from stdin
//   cat body.md | node scripts/report-to-docs.js "<title>"    # body from stdin
//
// 必要な資格情報:
//   ~/.gcp-docs-credentials.json   Google サービスアカウントキー（chmod 600 推奨）
//   ~/.claude-notify.env           Telegram Bot Token / Chat ID
//
// 追記フォーマット:
//   [YYYY-MM-DD HH:MM] {title}
//   {body}
//
// Docs 追記が失敗した場合は非ゼロで終了。Docs は成功したが Telegram が失敗した場合は
// 警告のみ出力して exit 0（Docs 記載が主目的、通知は副次的）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');

const DOC_ID = '1ET0v6zuyCgEbUDYwH8_xeCgnB4ff8GUYtRSbRGJ59fQ';
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;
const CRED_PATH = path.join(os.homedir(), '.gcp-docs-credentials.json');
const NOTIFY_ENV_PATH = path.join(os.homedir(), '.claude-notify.env');

function usageAndExit() {
  console.error('Usage: node scripts/report-to-docs.js "<title>" <body-file|->');
  console.error('       body-file を省略 or "-" にすると標準入力から読み込む');
  process.exit(2);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function loadNotifyEnv() {
  try {
    const raw = fs.readFileSync(NOTIFY_ENV_PATH, 'utf-8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
    return out;
  } catch (_) {
    return {};
  }
}

async function appendToDoc(title, body) {
  const auth = new google.auth.GoogleAuth({
    keyFile: CRED_PATH,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId: DOC_ID });
  const content = (doc.data.body && doc.data.body.content) || [];
  // 末尾要素の endIndex - 1 に挿入（末尾の暗黙の改行の直前）
  const lastEndIndex = content.length > 0
    ? content[content.length - 1].endIndex
    : 2;
  const insertIndex = Math.max(1, lastEndIndex - 1);

  const header = `[${nowStamp()}] ${title}`;
  // 既存本文がある場合のみ空行区切りを入れる（初回投稿時の先頭空行を避ける）
  const separator = insertIndex > 1 ? '\n\n' : '';
  const text = `${separator}${header}\n${body}\n`;

  // updateParagraphStyle の対象範囲を算出（挿入テキスト内オフセット基準）
  const headerStart = insertIndex + separator.length;
  const headerEnd = headerStart + header.length + 1; // ヘッダ末尾の \n を含む
  const insertedEnd = insertIndex + text.length;

  await docs.documents.batchUpdate({
    documentId: DOC_ID,
    requestBody: {
      requests: [
        { insertText: { location: { index: insertIndex }, text } },
        // まず挿入範囲全体を NORMAL_TEXT にリセット
        // （前回投稿の末尾が HEADING_2 のまま残っている場合の style 継承を防ぐ）
        {
          updateParagraphStyle: {
            range: { startIndex: insertIndex, endIndex: insertedEnd },
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            fields: 'namedStyleType',
          },
        },
        // 見出し行のみ HEADING_2 に上書き
        {
          updateParagraphStyle: {
            range: { startIndex: headerStart, endIndex: headerEnd },
            paragraphStyle: { namedStyleType: 'HEADING_2' },
            fields: 'namedStyleType',
          },
        },
      ],
    },
  });
}

async function sendTelegram(title, body) {
  const env = loadNotifyEnv();
  const token = env.CLAUDE_NOTIFY_BOT_TOKEN;
  const chatId = env.CLAUDE_NOTIFY_CHAT_ID;
  if (!token || !chatId) {
    console.error('[report-to-docs] warn: Telegram credentials missing in ' +
                  NOTIFY_ENV_PATH + ', skip notify');
    return;
  }
  const summary = body
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n')
    .slice(0, 400);

  const message = `📄 報告をDocsに記載: ${title}\n${DOC_URL}\n${summary}`;

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text: message },
    { timeout: 10000 },
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usageAndExit();
  const title = args[0];
  if (!title || !title.trim()) usageAndExit();

  const bodyArg = args[1];
  let body;
  if (!bodyArg || bodyArg === '-') {
    if (process.stdin.isTTY) {
      console.error('[report-to-docs] error: 本文が指定されていません' +
                    '（ファイルパス指定または標準入力へのパイプが必要）');
      process.exit(2);
    }
    body = (await readStdin()).replace(/\s+$/, '');
  } else {
    body = fs.readFileSync(bodyArg, 'utf-8').replace(/\s+$/, '');
  }
  if (!body) {
    console.error('[report-to-docs] error: 本文が空です');
    process.exit(2);
  }

  await appendToDoc(title, body);
  console.log(`[report-to-docs] ok: Docs に追記しました: ${title}`);
  console.log(`[report-to-docs]     ${DOC_URL}`);

  try {
    await sendTelegram(title, body);
    console.log('[report-to-docs] ok: Telegram 通知送信完了');
  } catch (e) {
    // Docs 追記は成功しているので、通知失敗は警告のみ
    console.error('[report-to-docs] warn: Telegram 通知に失敗:',
                  e && e.message ? e.message : e);
  }
}

main().catch(err => {
  console.error('[report-to-docs] error:',
                err && err.message ? err.message : err);
  process.exit(1);
});
