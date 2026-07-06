#!/usr/bin/env node
// Pair 1/2/3 の統合適用 (idempotent 冪等スクリプト)
//
// Pair 1 (りそうのコーヒー系):
//   id=4「risou no Coffee 30」 crossmallItemCode: null -> 2314-001811
//   id=21/62 は変更なし
//
// Pair 2 (デイリーワン系、案A):
//   id=13 を残す (DetectedItem 151件 > id=71 の 1件)、以下に更新:
//     keyword: 「デイリーワン」 -> 「デイリーワン マウス」
//     crossmallItemCode: null -> 2314-000889
//   id=71 削除 (同一実体重複)
//   id=182 (プレミアム、2314-001893) は独立維持
//
// Pair 3 (ホワイトハンドセラム系):
//   id=19「ホワイトハンドセラム 20ml」 crossmallItemCode: null -> 2314-001819
//   id=145 は変更なし
//
// Pair 4 (エティアキシル系): 案D 保留、現状維持
//
// 冪等性: 既に統合済みでも副作用なし (verify only)

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword } = require('../src/models');

async function ensureUpdate(id, expected, patch) {
  const kw = await Keyword.findByPk(id);
  if (!kw) {
    console.error(`[pair] id=${id} が存在しません`);
    return;
  }
  const already = Object.entries(patch).every(([k, v]) => kw[k] === v);
  if (already) {
    console.log(`[pair] id=${id} は既に更新済み: ${JSON.stringify(patch)}`);
    return;
  }
  const before = {};
  for (const k of Object.keys(patch)) before[k] = kw[k];
  await kw.update(patch);
  console.log(`[pair] id=${id} 更新: before=${JSON.stringify(before)} -> after=${JSON.stringify(patch)}`);
}

async function ensureDelete(id) {
  const kw = await Keyword.findByPk(id);
  if (!kw) {
    console.log(`[pair] id=${id} は既に削除済み`);
    return;
  }
  console.log(`[pair] id=${id} 削除: keyword="${kw.keyword}" code=${kw.crossmallItemCode}`);
  await kw.destroy();
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const before = await Keyword.count();
  console.log(`[pair] 開始時 Keyword 総数: ${before}`);

  console.log('\n--- Pair 1: りそうのコーヒー系 ---');
  await ensureUpdate(4, {}, { crossmallItemCode: '2314-001811' });

  console.log('\n--- Pair 2: デイリーワン系 (案A、id=13 残・id=71 削除) ---');
  await ensureUpdate(13, {}, { keyword: 'デイリーワン マウス', crossmallItemCode: '2314-000889' });
  await ensureDelete(71);

  console.log('\n--- Pair 3: ホワイトハンドセラム系 ---');
  await ensureUpdate(19, {}, { crossmallItemCode: '2314-001819' });

  const after = await Keyword.count();
  console.log(`\n[pair] 完了。Keyword 総数: ${before} -> ${after}`);

  // 変更後の検証
  console.log('\n--- 変更後確認 ---');
  const ids = [4, 13, 19, 21, 53, 62, 71, 80, 98, 145, 182];
  const kws = await Keyword.findAll({ where: { id: ids }, order: [['id', 'ASC']], raw: true });
  for (const kw of kws) console.log(`  id=${kw.id} keyword="${kw.keyword}" code=${kw.crossmallItemCode}`);
  const missing = ids.filter(i => !kws.find(k => k.id === i));
  if (missing.length > 0) console.log(`  (削除済: id=${missing.join(',')})`);

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
