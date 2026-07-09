#!/usr/bin/env node
// Task 4 (案C): id=62「risou no cofffee」(typo keyword) を削除
//
// 判断根拠 (Case D 検証結果、owner 承認済み):
//   - Mercari API 直接検索で 0件返却 = typo 対策として機能していない
//   - 正スペル「risou no coffee」は 29件返却 (id=4 でカバー中)
//   - crossmallItemCode 2314-001811 は id=4, id=21 で継続カバー
//
// 実装:
//   - id=62 を Keyword.destroy
//   - 孤立 DetectedItem は履歴として残置 (前例通り)
//
// 冪等性: 既に削除済みでも副作用なし

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const before = await Keyword.count();
  console.log(`[delete-id62] 開始時 Keyword 総数: ${before}`);

  // 事前確認: 同 itemCode(2314-001811) の他 keyword が残ることを確認
  const kw62 = await Keyword.findByPk(62);
  if (!kw62) {
    console.log('  id=62 は既に削除済み');
    await sequelize.close();
    return;
  }
  const code = kw62.crossmallItemCode;
  console.log(`  削除対象: id=62 "${kw62.keyword}" code=${code}`);

  if (code) {
    const same = await Keyword.findAll({
      where: { crossmallItemCode: code },
      raw: true,
    });
    const remain = same.filter(k => k.id !== 62);
    console.log(`  同 itemCode(${code}) の残る keyword: ${remain.length}件`);
    for (const k of remain) {
      console.log(`    id=${k.id} "${k.keyword}"`);
    }
    if (remain.length === 0) {
      console.error('  ⚠️ 削除後 SKU 2314-001811 をカバーする keyword が 0 件になる、中止');
      process.exit(1);
    }
  }

  await kw62.destroy();
  const after = await Keyword.count();
  console.log(`\n[delete-id62] 完了。Keyword 総数: ${before} -> ${after}`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
