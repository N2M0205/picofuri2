#!/usr/bin/env node
// TierClassifier の動作確認テスト (実 DB 接続、読み取り専用)
// 使い方: node scripts/test-tier-classifier.js

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword, CrossmallProduct } = require('../src/models');
const { classifyAll, stockDays, TIER } = require('../src/services/TierClassifier');
const { getKeywordGroups } = require('../src/services/KeywordGroupService');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const totalKw = await Keyword.count();
  console.log(`[test] baseline: Keyword total = ${totalKw}`);

  console.log('\n[test-1] classifyAll() の返り値構造');
  const result = await classifyAll();
  assert(Array.isArray(result.hot), 'result.hot is Array');
  assert(Array.isArray(result.warm), 'result.warm is Array');
  assert(Array.isArray(result.cold), 'result.cold is Array');
  assert(result.meta && typeof result.meta === 'object', 'result.meta is object');

  console.log('\n[test-2] hot+warm+cold+starredOos 合計 === Keyword 総数');
  const starredOosLen = (result.starredOos || []).length;
  const total = result.hot.length + result.warm.length + result.cold.length + starredOosLen;
  assert(total === totalKw, `total classified === Keyword.count() (${total} === ${totalKw})`);

  console.log('\n[test-3] meta 内訳の合計 === Keyword 総数');
  const metaSum = Object.values(result.meta).reduce((a, n) => a + n, 0);
  assert(metaSum === totalKw, `meta sum === Keyword.count() (${metaSum} === ${totalKw})`);

  console.log('\n[test-4] Hot に stock=0 の SKU が含まれない (誤判定排除)');
  const hotCodes = new Set(result.hot.map(k => k.crossmallItemCode).filter(Boolean));
  const stockZeroInHot = await CrossmallProduct.count({
    where: { itemCode: [...hotCodes], stock: 0 },
  });
  assert(stockZeroInHot === 0, `Hot 内 stock=0 の CrossmallProduct: ${stockZeroInHot}件 (0件が正常)`);

  console.log('\n[test-5] Hot に stock<0 の SKU が含まれない');
  const stockNegInHot = await CrossmallProduct.count({
    where: { itemCode: [...hotCodes], stock: { [Op.lt]: 0 } },
  });
  assert(stockNegInHot === 0, `Hot 内 stock<0 の CrossmallProduct: ${stockNegInHot}件 (0件が正常)`);

  console.log('\n[test-6] 同一 crossmallItemCode の全キーワードが同じ階層に入る (グルーピング整合性)');
  const groups = await getKeywordGroups();
  const kwIdToTier = new Map();
  for (const kw of result.hot) kwIdToTier.set(kw.id, 'hot');
  for (const kw of result.warm) kwIdToTier.set(kw.id, 'warm');
  for (const kw of result.cold) kwIdToTier.set(kw.id, 'cold');
  let sharedGroups = 0, mismatched = 0;
  for (const g of groups) {
    if (!g.itemCode || g.keywords.length < 2) continue;
    sharedGroups++;
    const tiers = new Set(g.keywords.map(k => kwIdToTier.get(k.id)));
    if (tiers.size !== 1) { mismatched++; console.error(`    ✗ グループ ${g.itemCode}: 混在 tiers=${[...tiers]}`); }
  }
  console.log(`  (対象: 共有グループ ${sharedGroups}組)`);
  assert(mismatched === 0, `階層混在した共有グループ: ${mismatched}組 (0組が正常)`);

  console.log('\n[test-7] Hot に含まれる SKU の在庫日数はすべて HOT_THRESHOLD_DAYS 以下');
  const hotMax = parseInt(process.env.HOT_THRESHOLD_DAYS, 10) || 3;
  const prods = await CrossmallProduct.findAll({ where: { itemCode: [...hotCodes] }, raw: true });
  const prodMap = new Map(prods.map(p => [p.itemCode, p]));
  let hotOver = 0;
  for (const kw of result.hot) {
    const p = prodMap.get(kw.crossmallItemCode);
    if (!p) { hotOver++; continue; }
    const d = stockDays(p.stock, p.sales28);
    if (d > hotMax) hotOver++;
  }
  assert(hotOver === 0, `Hot 中で days > ${hotMax} のもの: ${hotOver}件`);

  console.log('\n[test-8] Warm に含まれる SKU の在庫日数は (HOT_THRESHOLD_DAYS, WARM_THRESHOLD_DAYS] の範囲');
  const warmMax = parseInt(process.env.WARM_THRESHOLD_DAYS, 10) || 14;
  const warmCodes = new Set(result.warm.map(k => k.crossmallItemCode).filter(Boolean));
  const warmProds = await CrossmallProduct.findAll({ where: { itemCode: [...warmCodes] }, raw: true });
  const warmMap = new Map(warmProds.map(p => [p.itemCode, p]));
  let warmOut = 0;
  for (const kw of result.warm) {
    const p = warmMap.get(kw.crossmallItemCode);
    if (!p) { warmOut++; continue; }
    const d = stockDays(p.stock, p.sales28);
    if (!(d > hotMax && d <= warmMax)) warmOut++;
  }
  assert(warmOut === 0, `Warm 中で範囲外のもの: ${warmOut}件`);

  console.log('\n[test-9] 判定不可 (crossmallItemCode 未設定) の全キーワードが Cold に入る');
  const nullKw = await Keyword.findAll({ where: { crossmallItemCode: null }, attributes: ['id'], raw: true });
  const coldIds = new Set(result.cold.map(k => k.id));
  const misplaced = nullKw.filter(k => !coldIds.has(k.id));
  assert(misplaced.length === 0, `未マップキーワードは全て Cold へ (${nullKw.length}件、mismatched=${misplaced.length})`);

  console.log('\n[test-10] TIER 定数のエクスポート確認');
  assert(TIER.HOT === 'hot' && TIER.WARM === 'warm' && TIER.COLD === 'cold', 'TIER = {HOT, WARM, COLD}');

  console.log('\n=== 分布サマリ (参考) ===');
  console.log(`  Hot:  ${result.hot.length}件`);
  console.log(`  Warm: ${result.warm.length}件`);
  console.log(`  Cold: ${result.cold.length}件`);
  console.log(`  meta:`, result.meta);

  console.log('\n=== 結果 ===');
  console.log(`passed=${passed}, failed=${failed}`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('[test] fatal:', err); process.exit(1); });
