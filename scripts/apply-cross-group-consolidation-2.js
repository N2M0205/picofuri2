#!/usr/bin/env node
// 案B 第2弾: 同SKU グループの重複 keyword 統合
//
// 対象:
//   1. 2314-001247 セノッピー チュアブル: id=17 残す (108件) / id=16 削除 (16件)
//   2. 2314-000192 ルックルック イヌリン: id=20 残す (119件) / id=22 削除 (21件)
//
// 判断根拠 (Case D 検証結果を受けた owner 承認済み):
//   - いずれも残す側が明確に多い
//   - 前例 (トイラボ、cross-group-consolidation 第1弾) と同一手順
//
// 実装:
//   - 削除対象 2件を Keyword.destroy
//   - 残す側は無変更
//   - 孤立 DetectedItem は履歴として残置 (前例通り)
//
// 冪等性: 既に削除済みでも副作用なし

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');

const CONSOLIDATIONS = [
  { keep: 17, delete: 16, code: '2314-001247', label: 'セノッピー チュアブル' },
  { keep: 20, delete: 22, code: '2314-000192', label: 'ルックルック イヌリン' },
];

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const before = await Keyword.count();
  console.log(`[cross-group-2] 開始時 Keyword 総数: ${before}`);

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
  console.log(`\n[cross-group-2] 完了。Keyword 総数: ${before} -> ${after}`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
