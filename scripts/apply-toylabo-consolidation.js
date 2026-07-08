#!/usr/bin/env node
// トイラボ (id=1) / ToyLaBO (id=2) 統合 - 冪等スクリプト
//
// 背景:
//   両 keyword は同一 SKU (2314-001346) を指す表記ゆれ。
//   overlapping により id=1 のヒットが id=2 の先行検知に吸収されて 0件になる問題を解消。
//
// 判断 (owner 承認済み、DetectedItem 実績ベース):
//   - id=1 トイラボ: 8件、id=2 ToyLaBO: 37件 → 実績が多い id=2 を残す
//   - id=2 の filter.matchesKeyword は case-insensitive 正規化により
//     katakana 版より広く title にマッチする (直接検証で 38件 vs 24件)
//
// 実装:
//   - id=1 を削除 (Keyword.destroy)
//   - id=2 は無変更 (crossmallItemCode=2314-001346、既に維持済)
//   - id=1 由来の DetectedItem 8件は orphan として残置 (前例通り、履歴保全)
//     → keywordId=1 レコードは検索・通知には使われない (Keyword が存在しないため)
//
// 冪等性: 既に削除済みでも副作用なし

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');

const KEEP_ID = 2;
const DELETE_ID = 1;
const EXPECTED_CODE = '2314-001346';

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const before = await Keyword.count();
  console.log(`[toylabo] 開始時 Keyword 総数: ${before}`);

  const keep = await Keyword.findByPk(KEEP_ID, { raw: true });
  if (!keep) {
    console.error(`[toylabo] 残す予定の id=${KEEP_ID} が存在しません、処理中断`);
    process.exit(1);
  }
  console.log(`[toylabo] 残す: id=${KEEP_ID} keyword="${keep.keyword}" code=${keep.crossmallItemCode}`);
  if (keep.crossmallItemCode !== EXPECTED_CODE) {
    console.warn(`[toylabo] ⚠️ 残す side の code が想定と違います (${keep.crossmallItemCode} vs ${EXPECTED_CODE})`);
  }

  const del = await Keyword.findByPk(DELETE_ID);
  if (!del) {
    console.log(`[toylabo] id=${DELETE_ID} は既に削除済み`);
  } else {
    console.log(`[toylabo] 削除: id=${DELETE_ID} keyword="${del.keyword}" code=${del.crossmallItemCode}`);
    await del.destroy();
  }

  const after = await Keyword.count();
  console.log(`[toylabo] 完了。Keyword 総数: ${before} -> ${after}`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
