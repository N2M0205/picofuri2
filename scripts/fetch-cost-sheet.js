#!/usr/bin/env node
// scripts/fetch-cost-sheet.js
// Google Sheets「在庫マスタ」M 列 (原価) を picofuri2 が日次で取得し、
// picofuri2/picofuri3 が共有する DB (CostSheetCache テーブル) に UPSERT する。
// picofuri3 は Sheets API に直接アクセスしないため、本経路が原価取得の唯一手段。
//
// 使い方:
//   node scripts/fetch-cost-sheet.js
//
// 前提:
//   ~/.gcp-docs-credentials.json (Google service account、chmod 600)
//   Sheets API 有効化 + 「在庫マスタ」シートが picofuri2-reporter service
//     account に閲覧者共有されていること
//   CostSheetCache テーブルは初回実行時に sync() で自動作成 (CREATE IF NOT
//     EXISTS、alter は行わない)。既存テーブルには一切影響しない独立テーブル。
//
// cron 設定 (マージ・オーナー承認後):
//   crontab -e で以下を追記。fetch-rakuten-prices の 7:00 と離して 7:05。
//     5 7 * * * cd /home/picofuri2/picofuri2 && \
//       /usr/bin/env node scripts/fetch-cost-sheet.js \
//       >> /home/picofuri2/picofuri2/logs/fetch-cost-sheet.cron.log 2>&1
//
// 制約 (2026-09-02 指示遵守):
//   ・取得できない SKU があっても止めず、スキップして継続
//   ・実行毎に fetchedAt < now-3d の行を削除 (直近フォールバック 3 日分のみ保持)
//   ・完全 read (Sheet 側) / 独立テーブルへの write (DB 側)

'use strict';

// SKIP_DB_ALTER=true 強制設定 (production process と DB を共有するため、
// 他モデルの alter を厳禁化)。
process.env.SKIP_DB_ALTER = 'true';

const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const {
  parseCost,
  buildCostMap,
  computeStats,
  MONITORED_SHEET_COLUMN,
  INVENTORY_ITEM_CODE_COLUMN,
  RETENTION_DAYS,
} = require('./lib/cost-sheet-cache-lib');

const SPREADSHEET_ID = '16yGF5UnGVSEyHL0WdkbNkUDjkVGoAzDTBRNQPyRIEOs';
const INVENTORY_SHEET = '在庫マスタ';
const CRED_PATH = path.join(os.homedir(), '.gcp-docs-credentials.json');

function ts() {
  const d = new Date();
  const pad = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function fetchInventorySheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CRED_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const t0 = Date.now();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${INVENTORY_SHEET}!A1:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = res.data.values || [];
  return { values, elapsedMs: Date.now() - t0 };
}

async function main() {
  const runStart = Date.now();
  console.log(`[${ts()}] 在庫マスタ原価キャッシュバッチ 開始`);

  const { sequelize, Keyword, CostSheetCache } = require('../src/models');
  const { Op } = require('sequelize');

  // 独立テーブル、alter なしで CREATE IF NOT EXISTS のみ
  await CostSheetCache.sync();
  console.log(`[${ts()}] CostSheetCache テーブル ensure 完了`);

  // 監視対象 crossmallItemCode
  const kwRows = await Keyword.findAll({
    where: {
      isActive: true,
      crossmallItemCode: { [Op.not]: null },
    },
    attributes: ['crossmallItemCode'],
    raw: true,
  });
  const monitored = new Set(kwRows.map(k => k.crossmallItemCode).filter(Boolean));
  console.log(`[${ts()}] 監視対象 crossmallItemCode: ${monitored.size} 件`);

  // Sheet 取得
  const { values, elapsedMs } = await fetchInventorySheet();
  console.log(`[${ts()}] 在庫マスタ取得完了: ${values.length} 行、${elapsedMs} ms`);

  const costMap = buildCostMap(values, INVENTORY_ITEM_CODE_COLUMN, MONITORED_SHEET_COLUMN);
  console.log(`[${ts()}] 在庫マスタ 原価あり (シート全体): ${costMap.size} 件`);

  // INNER JOIN
  const matched = [];
  const notInSheet = [];
  const noCostInSheet = [];
  for (const code of monitored) {
    if (!costMap.has(code)) {
      notInSheet.push(code);
      continue;
    }
    const cost = costMap.get(code);
    if (cost === null) {
      noCostInSheet.push(code);
      continue;
    }
    matched.push({ crossmallItemCode: code, cost });
  }
  console.log(`[${ts()}] INNER JOIN: ${matched.length} SKU で原価取得成功`);
  console.log(`  ├ シート未収録              : ${notInSheet.length} 件`);
  console.log(`  └ シートに行あり、M 列が空・非数値: ${noCostInSheet.length} 件`);

  // UPSERT
  const now = new Date();
  let ok = 0;
  let failed = 0;
  const failures = [];
  for (const row of matched) {
    try {
      await CostSheetCache.upsert({
        crossmallItemCode: row.crossmallItemCode,
        cost: row.cost,
        fetchedAt: now,
      });
      ok++;
    } catch (e) {
      failed++;
      failures.push({ crossmallItemCode: row.crossmallItemCode, error: e.message });
    }
  }
  console.log(`[${ts()}] UPSERT 完了: ok=${ok}, failed=${failed}`);
  if (failures.length > 0) {
    console.warn('  UPSERT 失敗 (先頭 5):', failures.slice(0, 5));
  }

  // 3 日超え削除
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await CostSheetCache.destroy({
    where: { fetchedAt: { [Op.lt]: cutoff } },
  });
  console.log(`[${ts()}] 3 日超 (${cutoff.toISOString()} 以前) 削除: ${deleted} 行`);

  // 統計
  const totalCount = await CostSheetCache.count();
  const rows = await CostSheetCache.findAll({ raw: true, attributes: ['cost'] });
  const stats = computeStats(rows.map(r => r.cost));
  const totalElapsed = Date.now() - runStart;
  console.log(`[${ts()}] === 完了サマリ ===`);
  console.log(`  監視対象:                 ${monitored.size}`);
  console.log(`  取得成功 (UPSERT ok):     ${ok}`);
  console.log(`  シート未収録:             ${notInSheet.length}`);
  console.log(`  シート M 列 空・非数値:    ${noCostInSheet.length}`);
  console.log(`  UPSERT 失敗:              ${failed}`);
  console.log(`  CostSheetCache 現在行数:  ${totalCount}`);
  console.log(`  原価 min/median/max:       ${stats.min} / ${stats.median} / ${stats.max}`);
  console.log(`  合計所要時間:             ${totalElapsed} ms`);

  if (notInSheet.length > 0) {
    console.log('');
    console.log('シート未収録 SKU 一覧:');
    for (const c of notInSheet.slice(0, 50)) console.log('  ', c);
    if (notInSheet.length > 50) console.log(`  ...(+${notInSheet.length - 50} more)`);
  }
  if (noCostInSheet.length > 0) {
    console.log('');
    console.log('シート M 列 空・非数値 SKU 一覧:');
    for (const c of noCostInSheet.slice(0, 50)) console.log('  ', c);
    if (noCostInSheet.length > 50) console.log(`  ...(+${noCostInSheet.length - 50} more)`);
  }

  await sequelize.close();
}

if (require.main === module) {
  main().catch(async err => {
    console.error(`[${ts()}] FATAL:`, err.message);
    try {
      const { sequelize } = require('../src/models');
      await sequelize.close();
    } catch (_) {}
    process.exit(1);
  });
}
