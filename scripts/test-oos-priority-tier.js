#!/usr/bin/env node
// StarredOos tier + 欠品バッジ の動作確認テスト (実 DB 接続、読み取り専用)
// 使い方: node scripts/test-oos-priority-tier.js

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword, CrossmallProduct } = require('../src/models');
const { classifyAll, TIER } = require('../src/services/TierClassifier');
const NotificationService = require('../src/services/NotificationService');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const threshold = parseInt(process.env.STARRED_OOS_SALES28_THRESHOLD, 10) || 10;
  console.log(`[test] STARRED_OOS_SALES28_THRESHOLD = ${threshold}`);

  const totalKw = await Keyword.count();
  console.log(`[test] Keyword total = ${totalKw}`);

  console.log('\n[test-1] TIER.STARRED_OOS 定数のエクスポート');
  assert(TIER.STARRED_OOS === 'starredOos', 'TIER.STARRED_OOS === "starredOos"');

  console.log('\n[test-2] classifyAll() が starredOos バケットを返す');
  const result = await classifyAll();
  assert(Array.isArray(result.starredOos), 'result.starredOos is Array');
  assert(typeof result.meta.starredOos === 'number', 'result.meta.starredOos is number');

  console.log('\n[test-3] 全 tier 合計 === Keyword 総数');
  const total = result.hot.length + result.warm.length + result.cold.length + result.starredOos.length;
  assert(total === totalKw, `${total} === ${totalKw}`);

  console.log('\n[test-4] StarredOos の全キーワードが stock=0 かつ sales28 ≥ 閾値');
  let violation = 0;
  for (const kw of result.starredOos) {
    if (!kw.crossmallItemCode) { violation++; continue; }
    const p = await CrossmallProduct.findOne({ where: { itemCode: kw.crossmallItemCode }, raw: true });
    if (!p) { violation++; continue; }
    if (p.stock !== 0) violation++;
    if ((p.sales28 || 0) < threshold) violation++;
  }
  assert(violation === 0, `StarredOos 内で条件違反: ${violation}件 (0件が正常)`);

  console.log('\n[test-5] 通常欠品 (Cold reason=oos) は stock=0 かつ sales28 < 閾値');
  // meta.oos の件数と、実際に Cold に入っている stock=0 の低 sales28 商品との対応を確認
  const codesFromKw = await Keyword.findAll({ where: { crossmallItemCode: { [Op.not]: null } }, attributes: ['id', 'crossmallItemCode'], raw: true });
  const kwByCode = new Map();
  for (const k of codesFromKw) {
    if (!kwByCode.has(k.crossmallItemCode)) kwByCode.set(k.crossmallItemCode, []);
    kwByCode.get(k.crossmallItemCode).push(k.id);
  }
  const codes = [...kwByCode.keys()];
  const oosProducts = await CrossmallProduct.findAll({ where: { itemCode: codes, stock: 0 }, raw: true });
  const shouldBeStarred = oosProducts.filter(p => (p.sales28 || 0) >= threshold);
  const shouldBeCold = oosProducts.filter(p => (p.sales28 || 0) < threshold);
  const starredKwCount = shouldBeStarred.reduce((sum, p) => sum + (kwByCode.get(p.itemCode) || []).length, 0);
  const coldOosKwCount = shouldBeCold.reduce((sum, p) => sum + (kwByCode.get(p.itemCode) || []).length, 0);
  assert(result.meta.starredOos === starredKwCount, `meta.starredOos (${result.meta.starredOos}) === stock=0 & sales28>=${threshold} の kw 数 (${starredKwCount})`);
  assert(result.meta.oos === coldOosKwCount, `meta.oos (${result.meta.oos}) === stock=0 & sales28<${threshold} の kw 数 (${coldOosKwCount})`);

  console.log('\n[test-6] 負在庫 (stock<0) は StarredOos ではなく Cold');
  const negProducts = await CrossmallProduct.findAll({ where: { stock: { [Op.lt]: 0 } }, raw: true });
  const negCodes = new Set(negProducts.map(p => p.itemCode));
  const negInStarred = result.starredOos.filter(kw => negCodes.has(kw.crossmallItemCode)).length;
  assert(negInStarred === 0, `負在庫が StarredOos に含まれる: ${negInStarred}件 (0件が正常)`);

  console.log('\n[test-7] NotificationService buildMessage の欠品バッジ');
  const ns = new NotificationService();
  const item = {
    id: 'test-item-1', platform: 'mercari', title: 'テスト商品',
    price: 3000, itemUrl: 'https://example.com/test', listingCount: 5,
  };
  const kw = { keyword: 'テスト', crossmallItemCode: '2314-TEST' };

  // 通常欠品 (stock=0, sales28<閾値)
  const oosProduct = { stock: 0, sales28: 5, sales7: 0, lastSalePrice: 4000, deliveryType: null };
  const oosMsg = ns.buildMessage(item, kw, oosProduct);
  assert(oosMsg.startsWith('⚫欠品中'), '通常欠品: 「⚫欠品中」ラベルが先頭');
  assert(!oosMsg.startsWith('⭐'), '通常欠品: ⭐は付かない');

  // ⭐要注目欠品 (stock=0, sales28>=閾値)
  const starredProduct = { stock: 0, sales28: 15, sales7: 3, lastSalePrice: 4000, deliveryType: null };
  const starredMsg = ns.buildMessage(item, kw, starredProduct);
  assert(starredMsg.startsWith('⭐⚫欠品中(要注目)'), '⭐要注目欠品: 「⭐⚫欠品中(要注目)」ラベルが先頭');

  // 負在庫 (stock<0) は欠品扱いされるか (owner ルール: 通常欠品と同じ「⚫欠品中」)
  const negProduct = { stock: -8, sales28: 8, sales7: 0, lastSalePrice: 4000, deliveryType: null };
  const negMsg = ns.buildMessage(item, kw, negProduct);
  assert(negMsg.startsWith('⚫欠品中') && !negMsg.startsWith('⭐'), '負在庫: 「⚫欠品中」ラベル (⭐は付かない、Cold相当扱い)');

  // 通常商品 (stock>0) は欠品バッジなし
  const normalProduct = { stock: 10, sales28: 20, sales7: 5, lastSalePrice: 4000, deliveryType: null };
  const normalMsg = ns.buildMessage(item, kw, normalProduct);
  assert(!normalMsg.startsWith('⚫') && !normalMsg.startsWith('⭐'), '通常商品: 欠品バッジなし');

  console.log('\n=== 分布サマリ ===');
  console.log(`  Hot:        ${result.hot.length}件`);
  console.log(`  Warm:       ${result.warm.length}件`);
  console.log(`  StarredOos: ${result.starredOos.length}件`);
  console.log(`  Cold:       ${result.cold.length}件`);
  console.log(`  meta:`, result.meta);

  console.log('\n=== 結果 ===');
  console.log(`passed=${passed}, failed=${failed}`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('[test] fatal:', err); process.exit(1); });
