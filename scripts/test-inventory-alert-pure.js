#!/usr/bin/env node
// InventoryAlertService の純関数群 (DB 触らず) の単体テスト
// (2026-08-26 実装、feat/telegram-inventory-alert)
//
// 検証対象:
//   - calcDailySalesPace: 重み付き平均、weights の妥当性 (合計 1.0)
//   - calcStockDaysFromPace: 通常/欠品/日販=0 分岐
//   - classifyTier: 3 段階境界 (指示 v2: 🔴≤3, 🟡4-13, 🟢≥14)
//   - calcRecommendedQty: (14+5) × 日販 − 現在庫、負値切り下げ、日販=0 は 0
//   - isFresh: 4h 境界、null/未指定
//   - isEligible: 対象/対象外の 6 パターン
//   - buildDailyDigestMessage: 🔴 0件時のセクション省略
//   - buildNewlyRedMessage: 鮮度注意付与
//   - renderDashboardHtml: 3 セクション出力、escape

'use strict';

const svc = require('../src/services/InventoryAlertService');
const config = require('../src/config/inventoryAlert.json');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}
function assertEq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, `${name} (expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)})`);
}
function assertNear(actual, expected, name, tol = 0.0001) {
  const ok = Math.abs(actual - expected) < tol;
  assert(ok, `${name} (expected≈${expected}, actual=${actual})`);
}

console.log('[baseline] config sanity check');
const w = config.sales_weights;
const wsum = w.d1 + w.d7 + w.d14 + w.d28;
assertNear(wsum, 1.0, 'sales_weights 合計 = 1.0');
assert(config.target_stock_days === 14, 'target_stock_days = 14');
assert(config.lead_time_days === 5, 'lead_time_days = 5');
assert(config.tier_thresholds.red_max_days === 3, 'red_max_days = 3');
assert(config.tier_thresholds.yellow_max_days === 13, 'yellow_max_days = 13');
assert(config.freshness_warn_hours === 4, 'freshness_warn_hours = 4');

console.log('\n[test-1] calcDailySalesPace: 重み付き平均');
const pace1 = svc.calcDailySalesPace({sales1: 1, sales7: 7, sales14: 14, sales28: 28}, w);
// 全期間で「1/日」の定常状態 → 加重平均も 1
assertNear(pace1, 1.0, '定常 1/日 (sales1=1, s7=7, s14=14, s28=28) → pace = 1.0');
const pace1b = svc.calcDailySalesPace({sales1: 2, sales7: 7, sales14: 14, sales28: 28}, w);
// sales1=2 (=2/日) だが他は 1/日 → 加重で 1.15 (直近 1日で急伸を検知)
assertNear(pace1b, 1.15, 'sales1=2 で急伸検知 → 0.15*2 + 0.30 + 0.25 + 0.30 = 1.15');
const pace2 = svc.calcDailySalesPace({sales1: 0, sales7: 0, sales14: 0, sales28: 0}, w);
assertEq(pace2, 0, 'sales 全 0 → pace = 0');
const pace3 = svc.calcDailySalesPace({sales1: 10}, w);
// 0.15 * 10 + 0.30 * 0 + 0.25 * 0 + 0.30 * 0 = 1.5
assertNear(pace3, 1.5, 'sales1=10 のみ、他 undefined → 0.15*10 = 1.5');
const pace4 = svc.calcDailySalesPace({sales1: 4, sales7: 14, sales14: 21, sales28: 56}, w);
// 0.15*4 + 0.30*2 + 0.25*1.5 + 0.30*2 = 0.6 + 0.6 + 0.375 + 0.6 = 2.175
assertNear(pace4, 2.175, '混合ケース: 期待 2.175');

console.log('\n[test-2] calcStockDaysFromPace: 通常/欠品/日販=0');
assertEq(svc.calcStockDaysFromPace(10, 2), 5, 'stock=10, pace=2 → 5 日');
assertEq(svc.calcStockDaysFromPace(0, 2), 0, 'stock=0 → 0 日 (欠品)');
assertEq(svc.calcStockDaysFromPace(-1, 2), 0, 'stock<0 → 0 日 (負在庫扱い)');
assertEq(svc.calcStockDaysFromPace(10, 0), Infinity, 'pace=0 → Infinity');
assertEq(svc.calcStockDaysFromPace(10, null), Infinity, 'pace=null → Infinity');
assertEq(svc.calcStockDaysFromPace(null, 2), null, 'stock=null → null');

console.log('\n[test-3] classifyTier: 3 段階境界');
const th = config.tier_thresholds;
assertEq(svc.classifyTier(0, th), 'red', '0 日 → red');
assertEq(svc.classifyTier(3, th), 'red', '3 日 → red (境界含む)');
assertEq(svc.classifyTier(3.5, th), 'yellow', '3.5 日 → yellow');
assertEq(svc.classifyTier(4, th), 'yellow', '4 日 → yellow');
assertEq(svc.classifyTier(13, th), 'yellow', '13 日 → yellow (境界含む)');
assertEq(svc.classifyTier(13.5, th), 'green', '13.5 日 → green');
assertEq(svc.classifyTier(14, th), 'green', '14 日 → green');
assertEq(svc.classifyTier(365, th), 'green', '365 日 → green');
assertEq(svc.classifyTier(Infinity, th), 'green', 'Infinity → green');
assertEq(svc.classifyTier(null, th), null, 'null → null');

console.log('\n[test-4] calcRecommendedQty: (14+5) × pace − stock、負値切り下げ');
assertEq(svc.calcRecommendedQty(10, 2, 14, 5), 28, 'stock=10, pace=2 → 19*2-10 = 28');
assertEq(svc.calcRecommendedQty(0, 2, 14, 5), 38, 'stock=0, pace=2 → 19*2 = 38');
assertEq(svc.calcRecommendedQty(100, 2, 14, 5), 0, '既に潤沢 (stock=100, pace=2) → 負値 0 切り下げ');
assertEq(svc.calcRecommendedQty(10, 0, 14, 5), 0, 'pace=0 → 0 (計算スキップ)');
assertEq(svc.calcRecommendedQty(10, 1.5, 14, 5), 19, '小数 (19*1.5-10=18.5) → ceil 19');
assertEq(svc.calcRecommendedQty(10, null, 14, 5), 0, 'pace=null → 0');

console.log('\n[test-5] isFresh: 4h 境界');
const now = new Date('2026-08-26T12:00:00Z');
const t3h = new Date('2026-08-26T09:00:00Z'); // 3h 前 → fresh
const t4h = new Date('2026-08-26T08:00:00Z'); // 4h ぴったり → fresh (境界含む)
const t5h = new Date('2026-08-26T07:00:00Z'); // 5h 前 → not fresh
assertEq(svc.isFresh(t3h, 4, now), true, '3h 前 → fresh');
assertEq(svc.isFresh(t4h, 4, now), true, '4h ぴったり → fresh (境界)');
assertEq(svc.isFresh(t5h, 4, now), false, '5h 前 → not fresh');
assertEq(svc.isFresh(null, 4, now), false, 'null → not fresh');
assertEq(svc.isFresh(undefined, 4, now), false, 'undefined → not fresh');

console.log('\n[test-6] isEligible: 対象絞り込み');
assertEq(svc.isEligible(null, 1), false, 'マスタ不在 → 対象外');
assertEq(svc.isEligible({stock: -1}, 1), false, '負在庫 → 対象外');
assertEq(svc.isEligible({stock: 0}, 0), true, 'stock=0 → 対象 (指示 v2)');
assertEq(svc.isEligible({stock: 0}, 1), true, 'stock=0 かつ pace あり → 対象');
assertEq(svc.isEligible({stock: 10}, 0), false, 'stock>0 かつ pace=0 → 対象外');
assertEq(svc.isEligible({stock: 10}, 1), true, '通常 SKU → 対象');

console.log('\n[test-7] buildDailyDigestMessage');
const sample = [
  {skuCode: '001', skuName: 'A商品', itemName: 'A商品 詳細', tier: 'red', stock: 2, stockDays: 2, recommendedQty: 40, fresh: true},
  {skuCode: '002', skuName: 'B商品', itemName: 'B商品 詳細', tier: 'red', stock: 0, stockDays: 0, recommendedQty: 0, fresh: false},
  {skuCode: '003', skuName: 'C商品', itemName: 'C商品 詳細', tier: 'yellow', stock: 8, stockDays: 8, recommendedQty: 20, fresh: true},
  {skuCode: '004', skuName: 'D商品', itemName: 'D商品 詳細', tier: 'green', stock: 30, stockDays: 30, recommendedQty: 0, fresh: true},
];
const digest = svc.buildDailyDigestMessage(sample, 'https://example.trycloudflare.com', new Date('2026-08-26T08:00:00+09:00'));
assert(digest.includes('📦 在庫アラート'), 'ヘッダー含む');
assert(digest.includes('🔴 2件'), 'サマリ 🔴 件数');
assert(digest.includes('🟡 1件'), 'サマリ 🟡 件数');
assert(digest.includes('🟢 1件'), 'サマリ 🟢 件数');
assert(digest.includes('A商品 詳細'), '🔴 の商品名を含む');
assert(digest.includes('残0日 (欠品)'), '欠品表記');
assert(digest.includes('⚠️4h以上前'), '鮮度注意マーク');
assert(!digest.includes('C商品'), '🟡 は本文に出さない');
assert(!digest.includes('D商品'), '🟢 は本文に出さない');
assert(digest.includes('https://example.trycloudflare.com/inventory-alert'), 'tunnel URL 埋め込み');

const digestEmpty = svc.buildDailyDigestMessage(
  [{skuCode: 'x', skuName: 'X', itemName: 'X', tier: 'green', stock: 100, stockDays: 100, recommendedQty: 0, fresh: true}],
  'https://example.trycloudflare.com',
  new Date('2026-08-26T08:00:00+09:00')
);
assert(digestEmpty.includes('🔴 緊急該当なし'), '🔴 0件 → 「緊急該当なし」1行');
assert(!digestEmpty.includes('🔴 緊急（3日以内）'), '🔴 0件時はセクションヘッダーごと省略');

console.log('\n[test-8] buildNewlyRedMessage');
const msg1 = svc.buildNewlyRedMessage(sample[0], 'https://example.trycloudflare.com');
assert(msg1.includes('🚨 新たに緊急在庫'), 'リアルタイム見出し');
assert(msg1.includes('A商品 詳細'), '商品名');
assert(msg1.includes('残2日'), '在庫日数');
assert(msg1.includes('推奨仕入40個'), '推奨数');
assert(!msg1.includes('⚠️'), '鮮度 OK なら ⚠️ なし');

const msg2 = svc.buildNewlyRedMessage(sample[1], null);
assert(msg2.includes('残0日 (欠品)'), '欠品表記');
assert(msg2.includes('⚠️4h以上前'), '鮮度注意');
assert(!msg2.includes('▶️'), 'tunnel URL 不在時はリンク行なし');

console.log('\n[test-9] renderDashboardHtml');
const html = svc.renderDashboardHtml(sample, new Date('2026-08-26T08:00:00+09:00'));
assert(html.startsWith('<!DOCTYPE html>'), 'DOCTYPE');
assert(html.includes('<title>ピコフリ2 在庫アラート</title>'), 'title');
assert(html.includes('🔴 緊急（3日以内）（2件）'), '🔴 セクション件数');
assert(html.includes('🟡 注意（4〜13日）（1件）'), '🟡 セクション');
assert(html.includes('🟢 順調（14日以上）（1件）'), '🟢 セクション');
assert(html.includes('A商品 詳細'), '🔴 の商品名');
assert(html.includes('C商品 詳細'), '🟡 の商品名');
assert(html.includes('D商品 詳細'), '🟢 の商品名');
assert(!html.includes('<script>'), 'XSS: script tag なし');

// XSS 対策確認
const evilData = [{skuCode: '<script>', skuName: 'evil', itemName: '<img src=x onerror=alert(1)>', tier: 'red', stock: 1, stockDays: 1, recommendedQty: 1, fresh: true}];
const evilHtml = svc.renderDashboardHtml(evilData, new Date());
assert(!evilHtml.includes('<script>'), 'script タグは escape 済み');
assert(!evilHtml.includes('<img src=x onerror'), 'img タグは escape 済み');
assert(evilHtml.includes('&lt;script&gt;'), 'script は &lt;script&gt; に escape');
assert(evilHtml.includes('&lt;img src=x onerror=alert(1)&gt;'), 'img は escape');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
