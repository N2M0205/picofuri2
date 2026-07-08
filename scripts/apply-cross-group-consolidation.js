#!/usr/bin/env node
// 横展開: 3 SKU グループの重複 keyword 統合 (トイラボと同型)
//
// 対象:
//   1. 2314-001819 ホワイトハンドセラム: id=19 残す (178件) / id=145 削除 (0件)
//   2. 2314-000546 nico 石鹸: id=66 残す (3件) / id=67 削除 (0件)
//   3. 2314-001373 バルクス/VALX: id=72 残す (49件) / id=74 削除 (4件)
//
// 判断根拠 (owner 承認済み、DetectedItem 実績ベース):
//   - いずれも残す側が明確に多い or 削除側がゼロ
//   - 前例 (トイラボ、ホルモ、デイリーワン) と同一手順
//
// 実装:
//   - 削除対象 3件を Keyword.destroy
//   - 残す側は無変更
//   - 孤立 DetectedItem は履歴として残置 (前例通り)
//
// 冪等性: 既に削除済みでも副作用なし

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');

const CONSOLIDATIONS = [
  { keep: 19, delete: 145, code: '2314-001819', label: 'ホワイトハンドセラム' },
  { keep: 66, delete: 67,  code: '2314-000546', label: 'nico 石鹸' },
  { keep: 72, delete: 74,  code: '2314-001373', label: 'バルクス/VALX' },
];

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const before = await Keyword.count();
  console.log(`[cross-group] 開始時 Keyword 総数: ${before}`);

  for (const c of CONSOLIDATIONS) {
    console.log(`\n--- ${c.label} (${c.code}) ---`);
    const keep = await Keyword.findByPk(c.keep, { raw: true });
    if (!keep) {
      console.error(`  ⚠️ 残す予定 id=${c.keep} が存在しません、スキップ`);
      continue;
    }
    console.log(`  残す: id=${c.keep} keyword="${keep.keyword}" code=${keep.crossmallItemCode}`);
    if (keep.crossmallItemCode !== c.code) {
      console.warn(`  ⚠️ code 不一致: DB=${keep.crossmallItemCode} vs 期待=${c.code}`);
    }
    const del = await Keyword.findByPk(c.delete);
    if (!del) {
      console.log(`  id=${c.delete} は既に削除済み`);
    } else {
      console.log(`  削除: id=${c.delete} keyword="${del.keyword}" code=${del.crossmallItemCode}`);
      await del.destroy();
    }
  }

  const after = await Keyword.count();
  console.log(`\n[cross-group] 完了。Keyword 総数: ${before} -> ${after}`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
