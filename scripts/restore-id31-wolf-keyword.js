#!/usr/bin/env node
// id=31 の keyword を "& wolf" → "& wolf 002" に復元する。
//
// 背景:
//   Task 3-b の容量保持ルール付き短縮で id=31 は "& wolf 002" → "& wolf" に短縮された。
//   しかし FilterService.matchesKeyword の normalize は "&" を空白化するため、
//   有効トークンが汎用英単語 "wolf" 1個のみとなり、通知量が短縮前比 13.2倍
//   (6.9件/日 → 91.0件/日) に増加、91.4% が無関係商品(Jack Wolfskin, WOLF&RITA 等)
//   となった。
//
//   crossmallItemCode (2314-001180) / minPrice / maxPrice / excludeKeywords は変更不要。
//
// 使い方:
//   node scripts/restore-id31-wolf-keyword.js            # dry-run
//   node scripts/restore-id31-wolf-keyword.js --commit   # 実DB更新
//
// 事前: DB バックアップ必須。

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');

const IS_COMMIT = process.argv.includes('--commit');
const TARGET_ID = 31;
const NEW_KEYWORD = '& wolf 002';
const EXPECTED_OLD_KEYWORD = '& wolf';

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const kw = await Keyword.findByPk(TARGET_ID, { raw: true });
  if (!kw) {
    console.error(`ERROR: id=${TARGET_ID} が見つかりません`);
    process.exit(1);
  }

  console.log(`=== restore-id31-wolf-keyword ${IS_COMMIT ? '★ COMMIT ★' : 'dry-run'} ===`);
  console.log(`  id=${TARGET_ID}`);
  console.log(`  before: "${kw.keyword}"`);
  console.log(`  after : "${NEW_KEYWORD}"`);
  console.log(`  crossmallItemCode: ${kw.crossmallItemCode} (変更なし)`);
  console.log(`  minPrice/maxPrice: ${kw.minPrice}/${kw.maxPrice} (変更なし)`);
  console.log(`  excludeKeywords: "${kw.excludeKeywords}" (変更なし)`);

  if (kw.keyword !== EXPECTED_OLD_KEYWORD) {
    console.error(`\n⚠️ 現在の keyword が想定 ("${EXPECTED_OLD_KEYWORD}") と異なります。中断します。`);
    process.exit(2);
  }
  if (kw.keyword === NEW_KEYWORD) {
    console.log('\n既に "& wolf 002" です。何もしません。');
    process.exit(0);
  }

  if (!IS_COMMIT) {
    console.log('\n[dry-run] 変更は書き込まれていません。--commit を付けて再実行してください。');
    await sequelize.close();
    return;
  }

  const [n] = await Keyword.update({ keyword: NEW_KEYWORD }, { where: { id: TARGET_ID } });
  console.log(`\n★ COMMIT: ${n}件更新完了`);
  const after = await Keyword.findByPk(TARGET_ID, { raw: true });
  console.log(`  検証: id=${TARGET_ID} keyword="${after.keyword}"`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
