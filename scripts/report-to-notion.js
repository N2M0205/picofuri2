#!/usr/bin/env node
// scripts/report-to-notion.js
// 長文の実装結果・調査レポートを Notion データベースに新規ページとして追加し、
// Telegram にリンク+要約を通知する。旧 report-to-docs.js の後継 (2026-07-16 移行)。
//
// Usage (CLI):
//   node scripts/report-to-notion.js "<title>" <category> <body-file>
//   node scripts/report-to-notion.js "<title>" <category> -                # body from stdin
//   cat body.md | node scripts/report-to-notion.js "<title>" <category>
//
// Optional (env or flags):
//   --status=完了|進行中|保留   デフォルト: 完了
//   --branch=<branch-or-commit> ブランチ名 or コミットハッシュ
//
// Usage (require):
//   const { reportToNotion } = require('./report-to-notion');
//   const url = await reportToNotion({ title, category, status, branch, body });
//
// カテゴリ: 'Yahoo対応' | 'OR構文設計' | 'SKU整理' | '通知品質' |
//           'システム運用' | 'Win版比較' | 'その他'
// ステータス: '進行中' | '完了' | '保留'
//
// 必要な環境変数:
//   NOTION_API_KEY      Notion Integration Token
//   NOTION_DATABASE_ID  対象データベースID
//   CLAUDE_NOTIFY_BOT_TOKEN / CLAUDE_NOTIFY_CHAT_ID  Telegram (~/.claude-notify.env 参照)

'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const NOTION_VERSION = '2022-06-28';
const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTIFY_ENV_PATH = path.join(os.homedir(), '.claude-notify.env');

const VALID_CATEGORIES = new Set([
  'Yahoo対応', 'OR構文設計', 'SKU整理', '通知品質',
  'システム運用', 'Win版比較', 'その他',
]);
const VALID_STATUSES = new Set(['進行中', '完了', '保留']);

// Notion API 制約
const NOTION_MAX_TEXT_LEN = 2000;       // rich_text 1つあたりの content 文字数上限
const NOTION_MAX_BLOCKS_PER_CALL = 100; // /children append 1回あたりのブロック上限

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function todayIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function splitToChunks(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

function makeRichText(content) {
  return splitToChunks(content, NOTION_MAX_TEXT_LEN).map(chunk => ({
    type: 'text',
    text: { content: chunk },
  }));
}

function makeParagraph(content) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: makeRichText(content) },
  };
}

function makeHeading(level, content) {
  const key = `heading_${level}`;
  const clip = content.slice(0, NOTION_MAX_TEXT_LEN);
  return {
    object: 'block',
    type: key,
    [key]: { rich_text: [{ type: 'text', text: { content: clip } }] },
  };
}

function makeCodeBlock(content, language = 'plain text') {
  return {
    object: 'block',
    type: 'code',
    code: { rich_text: makeRichText(content), language },
  };
}

// Markdown-lite → Notion ブロック配列に変換
function bodyToNotionBlocks(body) {
  const lines = body.split('\n');
  const blocks = [];
  let paraBuf = [];
  let tableBuf = [];

  const flushPara = () => {
    if (!paraBuf.length) return;
    // 1 行 = 1 paragraph block として出力する。
    // 単一 paragraph の rich_text.text.content 内に \n を入れる方式では
    // Notion UI 上で改行として表示されないケースがある (2026-07-16 事象、
    // 段落内の改行が視認できず問題化) ため、行単位でブロックを分ける。
    for (const line of paraBuf) {
      blocks.push(makeParagraph(line));
    }
    paraBuf = [];
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    blocks.push(makeCodeBlock(tableBuf.join('\n')));
    tableBuf = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    // 表形式（先頭・末尾ともに '|'）を検出、連続する行を1つの code block に寄せる
    if (/^\|.*\|$/.test(trimmed)) {
      flushPara();
      tableBuf.push(line);
      continue;
    } else if (tableBuf.length) {
      flushTable();
    }

    // 見出し
    const h1 = /^# (.*)$/.exec(line);
    const h2 = /^## (.*)$/.exec(line);
    const h3 = /^### (.*)$/.exec(line);
    if (h3) {
      flushPara();
      blocks.push(makeHeading(3, h3[1]));
    } else if (h2) {
      flushPara();
      blocks.push(makeHeading(2, h2[1]));
    } else if (h1) {
      flushPara();
      blocks.push(makeHeading(1, h1[1]));
    } else if (trimmed === '') {
      // 空行は段落区切り
      flushPara();
    } else {
      paraBuf.push(line);
    }
  }
  flushTable();
  flushPara();
  return blocks;
}

async function notionRequest(method, endpoint, data) {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error('NOTION_API_KEY が未設定です');
  try {
    const res = await axios({
      method,
      url: `${NOTION_API_URL}${endpoint}`,
      data,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    const bodyMsg = e.response?.data?.message || e.message;
    if (status === 401 || status === 403) {
      throw new Error(
        `Notion 権限エラー (${status}): ${bodyMsg}\n` +
        `→ NOTION_API_KEY が有効か、Integration がデータベースに接続されているか確認してください`
      );
    }
    throw new Error(`Notion API エラー (${status || '?'}): ${bodyMsg}`);
  }
}

async function reportToNotion({ title, category, status, branch, body }) {
  if (!title || !title.trim()) throw new Error('title は必須です');
  if (!category) throw new Error('category は必須です');
  if (!VALID_CATEGORIES.has(category)) {
    throw new Error(
      `category "${category}" は無効です。有効値: ${[...VALID_CATEGORIES].join(' | ')}`
    );
  }
  const finalStatus = status || '完了';
  if (!VALID_STATUSES.has(finalStatus)) {
    throw new Error(
      `status "${finalStatus}" は無効です。有効値: ${[...VALID_STATUSES].join(' | ')}`
    );
  }
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error('NOTION_DATABASE_ID が未設定です');

  const properties = {
    'タイトル': { title: [{ type: 'text', text: { content: title } }] },
    'カテゴリ': { select: { name: category } },
    'ステータス': { select: { name: finalStatus } },
    '日付': { date: { start: todayIsoDate() } },
  };
  if (branch && branch.trim()) {
    properties['ブランチ/コミット'] = {
      rich_text: [{ type: 'text', text: { content: branch.trim() } }],
    };
  }

  const allBlocks = bodyToNotionBlocks(body || '');
  const firstBlocks = allBlocks.slice(0, NOTION_MAX_BLOCKS_PER_CALL);
  const remainingBlocks = allBlocks.slice(NOTION_MAX_BLOCKS_PER_CALL);

  const page = await notionRequest('POST', '/pages', {
    parent: { database_id: dbId },
    properties,
    children: firstBlocks,
  });
  const pageId = page.id;
  const pageUrl = page.url;

  // 残ブロックは 100 件ずつ append
  for (let i = 0; i < remainingBlocks.length; i += NOTION_MAX_BLOCKS_PER_CALL) {
    const chunk = remainingBlocks.slice(i, i + NOTION_MAX_BLOCKS_PER_CALL);
    await notionRequest('PATCH', `/blocks/${pageId}/children`, { children: chunk });
  }

  return pageUrl;
}

// ===== CLI =====

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

async function sendTelegram(title, body, pageUrl) {
  const env = loadNotifyEnv();
  const token = env.CLAUDE_NOTIFY_BOT_TOKEN;
  const chatId = env.CLAUDE_NOTIFY_CHAT_ID;
  if (!token || !chatId) {
    console.error('[report-to-notion] warn: Telegram credentials missing in ' +
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

  const message = `📄 報告をNotionに記載: ${title}\n${pageUrl}\n${summary}`;

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text: message },
    { timeout: 10000 },
  );
}

function usageAndExit() {
  console.error('Usage: node scripts/report-to-notion.js "<title>" <category> <body-file|->');
  console.error('  category: Yahoo対応 | OR構文設計 | SKU整理 | 通知品質 | システム運用 | Win版比較 | その他');
  console.error('  options: --status=進行中|完了|保留 (default 完了)');
  console.error('           --branch=<branch-or-commit>');
  process.exit(2);
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

async function main() {
  const args = process.argv.slice(2);
  // フラグとポジショナル引数を分離
  const positional = [];
  let status = '完了';
  let branch = '';
  for (const a of args) {
    if (a.startsWith('--status=')) status = a.slice('--status='.length);
    else if (a.startsWith('--branch=')) branch = a.slice('--branch='.length);
    else positional.push(a);
  }
  if (positional.length < 2) usageAndExit();
  const [title, category, bodyArg] = positional;

  let body;
  if (!bodyArg || bodyArg === '-') {
    if (process.stdin.isTTY) {
      console.error('[report-to-notion] error: 本文が指定されていません');
      process.exit(2);
    }
    body = (await readStdin()).replace(/\s+$/, '');
  } else {
    body = fs.readFileSync(bodyArg, 'utf-8').replace(/\s+$/, '');
  }
  if (!body) {
    console.error('[report-to-notion] error: 本文が空です');
    process.exit(2);
  }

  const pageUrl = await reportToNotion({ title, category, status, branch, body });
  console.log(`[report-to-notion] ok: Notion に追加しました: ${title}`);
  console.log(`[report-to-notion]     ${pageUrl}`);

  try {
    await sendTelegram(title, body, pageUrl);
    console.log('[report-to-notion] ok: Telegram 通知送信完了');
  } catch (e) {
    console.error('[report-to-notion] warn: Telegram 通知に失敗:',
                  e && e.message ? e.message : e);
  }
}

// require されたときは reportToNotion を export、直接実行時のみ main を走らせる
if (require.main === module) {
  main().catch(err => {
    console.error('[report-to-notion] error:',
                  err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { reportToNotion };
