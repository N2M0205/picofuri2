#!/usr/bin/env node
// scripts/fetch-rakuten-prices.js
// 楽天 RMS (Rakuten Item API 2.0) から本町店の全商品を取得し、picofuri2 の
// 365 監視対象 SKU (Keywords.crossmallItemCode) と INNER JOIN、RakutenPrice
// テーブルに UPSERT する。3 日より古い行は削除。
//
// 使い方:
//   node scripts/fetch-rakuten-prices.js
//
// 前提:
//   .env に RMS_SERVICE_SECRET_HONMACHI / RMS_LICENSE_KEY_HONMACHI が設定済み。
//   RakutenPrice テーブルは初回実行時に sync() で自動作成される (create-if-not-exists、
//   alter は行わない)。既存テーブルには一切影響しない独立テーブル。
//
// cron 設定 (マージ・オーナー承認後):
//   crontab -e で以下を追記。item robot の朝 6:00 更新から時間を空けて 7:00 実行。
//     0 7 * * * cd /home/picofuri2/picofuri2 && \
//       /usr/bin/env node scripts/fetch-rakuten-prices.js \
//       >> /home/picofuri2/picofuri2/logs/fetch-rakuten-prices.cron.log 2>&1
//
// 制約 (2026-09-02 指示遵守):
//   ・API 認証キーの値そのものは stdout・ログに出さない
//   ・取得できない SKU があっても止めず、スキップして継続
//   ・原価データ (在庫マスタ M 列) との連携は本スクリプトでは行わない

'use strict';

// SKIP_DB_ALTER=true 環境変数を強制設定 (initDB を呼ばないが、念のため)。
// 本スクリプトは production process (pm2) と DB を共有するため、他モデルの
// alter 実行を厳禁とする。
process.env.SKIP_DB_ALTER = 'true';

require('dotenv').config();
const axios = require('axios');
const { sequelize, Keyword, RakutenPrice } = require('../src/models');
const { Op } = require('sequelize');
const { extractPrice, extractImageUrl } = require('./lib/rakuten-price-lib');

const RMS_BASE = 'https://api.rms.rakuten.co.jp/es/2.0';
const HITS_PER_PAGE = 100; // 楽天 RMS 上限
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_ON_5XX = 2;
const RETRY_DELAY_MS = 1500;
const RETENTION_DAYS = 3;
// 本町店 (honmachi-store) 固定。imageUrl 絶対化用の CABINET base path shopId。
const SHOP_ID = 'honmachi-store';

function authHeader() {
  const secret = process.env.RMS_SERVICE_SECRET_HONMACHI;
  const key = process.env.RMS_LICENSE_KEY_HONMACHI;
  if (!secret || !key) {
    throw new Error('RMS_SERVICE_SECRET_HONMACHI / RMS_LICENSE_KEY_HONMACHI が未設定');
  }
  return 'ESA ' + Buffer.from(secret + ':' + key, 'utf-8').toString('base64');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(offset, auth) {
  const url = `${RMS_BASE}/items/search?hits=${HITS_PER_PAGE}&offset=${offset}`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_ON_5XX; attempt++) {
    try {
      const t0 = Date.now();
      const res = await axios.get(url, {
        headers: { Authorization: auth, Accept: 'application/json' },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
      const elapsed = Date.now() - t0;
      if (res.status === 200) {
        return { data: res.data, elapsedMs: elapsed, attempts: attempt + 1 };
      }
      lastErr = new Error(`HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      // 4xx はリトライ不要
      if (res.status >= 400 && res.status < 500) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (err.response && err.response.status >= 400 && err.response.status < 500) throw err;
    }
    if (attempt < RETRY_ON_5XX) await sleep(RETRY_DELAY_MS);
  }
  throw lastErr;
}

// extractPrice / extractImageUrl は scripts/lib/rakuten-price-lib.js に集約
// (require 済)。ここに定義しないことで、テスト可能な純粋関数として一元管理。

async function fetchAllHonmachiItems(auth) {
  const startedAt = Date.now();
  const items = [];
  const requestLog = [];

  // 1 ページ目でトータル件数を確認
  const first = await fetchPage(0, auth);
  requestLog.push({ offset: 0, elapsedMs: first.elapsedMs, attempts: first.attempts });
  const numFound = first.data.numFound || 0;
  for (const r of first.data.results || []) items.push(r.item);

  const totalPages = Math.ceil(numFound / HITS_PER_PAGE);
  for (let page = 1; page < totalPages; page++) {
    const offset = page * HITS_PER_PAGE;
    const res = await fetchPage(offset, auth);
    requestLog.push({ offset, elapsedMs: res.elapsedMs, attempts: res.attempts });
    for (const r of res.data.results || []) items.push(r.item);
  }

  return {
    items,
    numFound,
    requestLog,
    totalElapsedMs: Date.now() - startedAt,
  };
}

async function loadMonitoredCodes() {
  const rows = await Keyword.findAll({
    where: {
      isActive: true,
      crossmallItemCode: { [Op.not]: null },
    },
    attributes: ['crossmallItemCode'],
    raw: true,
  });
  const set = new Set();
  for (const r of rows) {
    if (r.crossmallItemCode) set.add(r.crossmallItemCode);
  }
  return set;
}

async function ensureTable() {
  // 独立テーブル、alter なしで CREATE IF NOT EXISTS のみ実行
  await RakutenPrice.sync();
  // imageUrl 列を idempotent に追加 (feat/rakuten-price-imageurl で追加)。
  // Sequelize の sync({alter:true}) は避け、対象列限定で直接 ALTER TABLE。
  // 他テーブル・他列には一切影響しない。
  const [cols] = await sequelize.query('PRAGMA table_info(RakutenPrices)');
  const hasImageUrl = cols.some(c => c.name === 'imageUrl');
  if (!hasImageUrl) {
    await sequelize.query('ALTER TABLE RakutenPrices ADD COLUMN imageUrl VARCHAR(255)');
    console.log('[DB] RakutenPrices に imageUrl 列を追加');
  }
}

async function upsertPrices(matched) {
  const now = new Date();
  let ok = 0;
  let failed = 0;
  const failures = [];
  for (const row of matched) {
    try {
      await RakutenPrice.upsert({
        crossmallItemCode: row.crossmallItemCode,
        price: row.price,
        imageUrl: row.imageUrl || null,
        fetchedAt: now,
      });
      ok++;
    } catch (e) {
      failed++;
      failures.push({ crossmallItemCode: row.crossmallItemCode, error: e.message });
    }
  }
  return { ok, failed, failures };
}

async function pruneOld() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await RakutenPrice.destroy({
    where: { fetchedAt: { [Op.lt]: cutoff } },
  });
  return { deleted, cutoff };
}

function ts() {
  const d = new Date();
  const pad = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function main() {
  const runStart = Date.now();
  console.log(`[${ts()}] 楽天 RMS 現在価格取得バッチ 開始`);

  const auth = authHeader();
  await ensureTable();
  console.log(`[${ts()}] RakutenPrice テーブル ensure 完了`);

  const monitored = await loadMonitoredCodes();
  console.log(`[${ts()}] 監視対象 crossmallItemCode: ${monitored.size} 件`);

  const fetched = await fetchAllHonmachiItems(auth);
  console.log(`[${ts()}] 本町店 items/search 完了: ${fetched.items.length}/${fetched.numFound} 件、` +
              `${fetched.requestLog.length} リクエスト、` +
              `合計 ${fetched.totalElapsedMs} ms`);

  // 重複 manageNumber の警告
  const seen = new Set();
  const dupes = [];
  for (const it of fetched.items) {
    const mn = it && it.manageNumber;
    if (!mn) continue;
    if (seen.has(mn)) dupes.push(mn);
    seen.add(mn);
  }
  if (dupes.length > 0) {
    console.warn(`[${ts()}] WARN: manageNumber 重複あり ${dupes.length} 件 (例: ${dupes.slice(0, 5).join(', ')})`);
  }

  // INNER JOIN + 価格・imageUrl 抽出
  const matched = [];
  const missingPrice = [];
  const notInShop = [];
  let imageUrlFilled = 0;
  let imageUrlMissing = 0;
  for (const mn of monitored) {
    // 対応 item を検索
    const item = fetched.items.find(x => x && x.manageNumber === mn);
    if (!item) {
      notInShop.push(mn);
      continue;
    }
    const { price, variantCount } = extractPrice(item);
    if (price === null) {
      missingPrice.push({ mn, variantCount });
      continue;
    }
    const imageUrl = extractImageUrl(item, SHOP_ID);
    if (imageUrl) imageUrlFilled++;
    else imageUrlMissing++;
    matched.push({ crossmallItemCode: mn, price, imageUrl });
  }

  console.log(`[${ts()}] INNER JOIN: ${matched.length} SKU で価格取得成功`);
  console.log(`  ├ 店舗に未登録 (items/search に不在) : ${notInShop.length} 件`);
  console.log(`  ├ 店舗にはあるが standardPrice 抽出不可: ${missingPrice.length} 件`);
  console.log(`  └ imageUrl 埋め率: ${imageUrlFilled}/${matched.length} (未取得 ${imageUrlMissing} 件)`);

  // UPSERT
  const up = await upsertPrices(matched);
  console.log(`[${ts()}] UPSERT 完了: ok=${up.ok}, failed=${up.failed}`);
  if (up.failures.length > 0) {
    console.warn('  UPSERT 失敗 (先頭 5):', up.failures.slice(0, 5));
  }

  // 3 日超え削除
  const pr = await pruneOld();
  console.log(`[${ts()}] 3 日超 (${pr.cutoff.toISOString()} 以前) 削除: ${pr.deleted} 行`);

  // 最終サマリ
  const totalElapsed = Date.now() - runStart;
  const totalCount = await RakutenPrice.count();
  console.log(`[${ts()}] === 完了サマリ ===`);
  console.log(`  監視対象:                 ${monitored.size}`);
  console.log(`  取得成功 (UPSERT ok):     ${up.ok}`);
  console.log(`  店舗未登録:               ${notInShop.length}`);
  console.log(`  価格抽出不可:             ${missingPrice.length}`);
  console.log(`  imageUrl 埋め:            ${imageUrlFilled} (未取得 ${imageUrlMissing})`);
  console.log(`  UPSERT 失敗:              ${up.failed}`);
  console.log(`  RakutenPrice 現在行数:    ${totalCount}`);
  console.log(`  API リクエスト数:         ${fetched.requestLog.length}`);
  console.log(`  合計所要時間:             ${totalElapsed} ms`);

  if (notInShop.length > 0) {
    console.log('');
    console.log('店舗未登録 SKU 一覧:');
    for (const c of notInShop.slice(0, 100)) console.log('  ', c);
    if (notInShop.length > 100) console.log(`  ...(+${notInShop.length - 100} more)`);
  }
  if (missingPrice.length > 0) {
    console.log('');
    console.log('価格抽出不可 SKU 一覧:');
    for (const m of missingPrice.slice(0, 100)) {
      console.log(`   ${m.mn} (variantCount=${m.variantCount})`);
    }
    if (missingPrice.length > 100) console.log(`  ...(+${missingPrice.length - 100} more)`);
  }

  await sequelize.close();
}

main().catch(async err => {
  console.error(`[${ts()}] FATAL:`, err.message);
  try { await sequelize.close(); } catch (_) {}
  process.exit(1);
});
