#!/usr/bin/env node
// 判定ラベル順序 案B の実データ検証テスト
// 直近24hの通知データを再判定し、想定分布 (💎22件、✅8件、🚨26件) と一致するか確認。
// 実装: NotificationService.calcJudgement (順序変更後、閾値不変)
// 使い方: node scripts/test-notification-label-order.js

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, DetectedItem, Keyword, CrossmallProduct } = require('../src/models');
const NotificationService = require('../src/services/NotificationService');
const { getShippingCost } = require('../src/config/shippingCost');

// 想定分布 (前回シミュレーション結果、案B の予測値)
const EXPECTED = {
  '💎 高利益': 22,
  '✅ 即買い': 8,
  '🚨 緊急仕入': 26,
};

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const ns = new NotificationService();
  const now = new Date();
  const from = new Date(now - 24 * 60 * 60 * 1000);
  const items = await DetectedItem.findAll({
    where: { notifiedAt: { [Op.gte]: from }, notified: true },
    raw: true,
  });
  console.log(`[test] 24h notified items: ${items.length}`);

  const labels = {};
  for (const it of items) {
    const kw = await Keyword.findByPk(it.keywordId, { raw: true });
    if (!kw) continue;
    let product = null;
    if (kw.crossmallItemCode) {
      product = await CrossmallProduct.findOne({
        where: { itemCode: kw.crossmallItemCode }, raw: true,
      });
    }
    const stock = product?.stock ?? 0;
    const sales28 = product?.sales28 ?? 0;
    const sales7 = product?.sales7 ?? 0;
    const lastSalePrice = product?.lastSalePrice ?? 0;
    const deliveryType = product?.deliveryType ?? null;
    const shippingCost = getShippingCost(deliveryType);
    const stockDays = ns.calcStockDays(stock, sales28);
    const profitResult = ns.calcProfit(lastSalePrice, shippingCost, it.price);
    const profitRate = profitResult?.profitRate ?? 0;
    const isRare = (it.listingCount ?? 99) <= 2;

    const label = lastSalePrice > 0
      ? ns.calcJudgement(profitRate, sales7, stockDays, isRare)
      : '📋 参考';
    labels[label] = (labels[label] || 0) + 1;
  }

  console.log('\n=== 実測ラベル分布 ===');
  const sorted = Object.entries(labels).sort((a, b) => b[1] - a[1]);
  for (const [l, c] of sorted) console.log(`  ${l.padEnd(20)}  ${c}件`);

  console.log('\n=== 想定分布との近似一致確認 (±3件許容: 24h ウィンドウの自然ドリフト吸収) ===');
  for (const [expLabel, expCount] of Object.entries(EXPECTED)) {
    const actual = labels[expLabel] || 0;
    const diff = Math.abs(actual - expCount);
    assert(
      diff <= 3,
      `${expLabel} = ${actual}件 (想定 ${expCount}件、差 ${diff}、許容 ±3)`
    );
  }

  console.log('\n=== 順序変更の期待効果 (前ラベル→後ラベル) の方向性確認 ===');
  const before = { '💎 高利益': 7, '✅ 即買い': 0, '🚨 緊急仕入': 49 };
  assert((labels['💎 高利益'] || 0) > before['💎 高利益'],
    `💎 高利益: 増加した (${before['💎 高利益']} → ${labels['💎 高利益'] || 0})`);
  assert((labels['✅ 即買い'] || 0) > before['✅ 即買い'],
    `✅ 即買い: 増加した (${before['✅ 即買い']} → ${labels['✅ 即買い'] || 0})`);
  assert((labels['🚨 緊急仕入'] || 0) < before['🚨 緊急仕入'],
    `🚨 緊急仕入: 減少した (${before['🚨 緊急仕入']} → ${labels['🚨 緊急仕入'] || 0})`);

  console.log('\n=== 参考: 順序変更前後の差分 ===');
  const beforeRef = { '💎 高利益': 7, '✅ 即買い': 0, '🚨 緊急仕入': 49 };
  console.log(`  💎 高利益: ${beforeRef['💎 高利益']} → ${labels['💎 高利益'] || 0}  (差 ${(labels['💎 高利益'] || 0) - beforeRef['💎 高利益']})`);
  console.log(`  ✅ 即買い: ${beforeRef['✅ 即買い']} → ${labels['✅ 即買い'] || 0}  (差 ${(labels['✅ 即買い'] || 0) - beforeRef['✅ 即買い']})`);
  console.log(`  🚨 緊急仕入: ${beforeRef['🚨 緊急仕入']} → ${labels['🚨 緊急仕入'] || 0}  (差 ${(labels['🚨 緊急仕入'] || 0) - beforeRef['🚨 緊急仕入']})`);

  console.log('\n=== 結果 ===');
  console.log(`passed=${passed}, failed=${failed}`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('[test] fatal:', err); process.exit(1); });
