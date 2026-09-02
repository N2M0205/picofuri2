// test/fetch-cost-sheet.test.js
// Node.js 組込みテストランナー (node --test) 用。追加依存ゼロ。
// 実行: node --test test/fetch-cost-sheet.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseCost,
  buildCostMap,
  computeStats,
} = require('../scripts/lib/cost-sheet-cache-lib');

// ============================================================================
// parseCost
// ============================================================================

test('parseCost: 整数文字列', () => {
  assert.strictEqual(parseCost('1234'), 1234);
});

test('parseCost: カンマ区切り整数', () => {
  assert.strictEqual(parseCost('1,234'), 1234);
});

test('parseCost: 3 桁カンマ 2 個 (10,000 円台)', () => {
  assert.strictEqual(parseCost('12,345'), 12345);
});

test('parseCost: 数値型 (Sheets の UNFORMATTED_VALUE)', () => {
  assert.strictEqual(parseCost(1234), 1234);
});

test('parseCost: 数値型 小数付き → 整数切り捨て', () => {
  assert.strictEqual(parseCost(1234.7), 1234);
});

test('parseCost: 文字列 小数付き → 整数切り捨て', () => {
  assert.strictEqual(parseCost('1234.7'), 1234);
});

test('parseCost: 前後スペース許容', () => {
  assert.strictEqual(parseCost('  1234  '), 1234);
});

test('parseCost: 空文字 → null', () => {
  assert.strictEqual(parseCost(''), null);
});

test('parseCost: null → null', () => {
  assert.strictEqual(parseCost(null), null);
});

test('parseCost: undefined → null', () => {
  assert.strictEqual(parseCost(undefined), null);
});

test('parseCost: 0 → null (原価 0 円は無効扱い)', () => {
  assert.strictEqual(parseCost(0), null);
  assert.strictEqual(parseCost('0'), null);
});

test('parseCost: 負数 → null', () => {
  assert.strictEqual(parseCost(-100), null);
  assert.strictEqual(parseCost('-100'), null);
});

test('parseCost: 数字以外を含む文字列 → null', () => {
  assert.strictEqual(parseCost('1234円'), null);
  assert.strictEqual(parseCost('abc'), null);
  assert.strictEqual(parseCost('¥1234'), null);
});

test('parseCost: 全角数字 → null (今回対象外仕様)', () => {
  assert.strictEqual(parseCost('１２３４'), null);
});

test('parseCost: NaN / Infinity → null', () => {
  assert.strictEqual(parseCost(NaN), null);
  assert.strictEqual(parseCost(Infinity), null);
});

// ============================================================================
// buildCostMap
// ============================================================================

test('buildCostMap: ヘッダ + 有効行 3 件', () => {
  const values = [
    ['商品コード', '商品名', '', '', '', '', '', '', '', '', '', '', '原価'],
    ['2314-000001', 'A', '', '', '', '', '', '', '', '', '', '', 100],
    ['2314-000002', 'B', '', '', '', '', '', '', '', '', '', '', '2,500'],
    ['2314-000003', 'C', '', '', '', '', '', '', '', '', '', '', 3300],
  ];
  const map = buildCostMap(values, 0, 12);
  assert.strictEqual(map.size, 3);
  assert.strictEqual(map.get('2314-000001'), 100);
  assert.strictEqual(map.get('2314-000002'), 2500);
  assert.strictEqual(map.get('2314-000003'), 3300);
});

test('buildCostMap: 商品コードが空の行はスキップ', () => {
  const values = [
    ['商品コード', '', '', '', '', '', '', '', '', '', '', '', '原価'],
    ['', 'A', '', '', '', '', '', '', '', '', '', '', 100],
    ['2314-000002', 'B', '', '', '', '', '', '', '', '', '', '', 200],
  ];
  const map = buildCostMap(values, 0, 12);
  assert.strictEqual(map.size, 1);
  assert.strictEqual(map.get('2314-000002'), 200);
});

test('buildCostMap: M 列が空/非数値の場合は null 格納 (行自体は認識)', () => {
  const values = [
    ['商品コード', '', '', '', '', '', '', '', '', '', '', '', '原価'],
    ['2314-000001', 'A', '', '', '', '', '', '', '', '', '', '', ''],
    ['2314-000002', 'B', '', '', '', '', '', '', '', '', '', '', 'N/A'],
    ['2314-000003', 'C', '', '', '', '', '', '', '', '', '', '', 500],
  ];
  const map = buildCostMap(values, 0, 12);
  assert.strictEqual(map.size, 3);
  assert.strictEqual(map.get('2314-000001'), null);
  assert.strictEqual(map.get('2314-000002'), null);
  assert.strictEqual(map.get('2314-000003'), 500);
});

test('buildCostMap: 同じコードが複数行あっても有効 cost を優先保持', () => {
  const values = [
    ['商品コード', '', '', '', '', '', '', '', '', '', '', '', '原価'],
    ['2314-000001', 'A', '', '', '', '', '', '', '', '', '', '', 100],
    ['2314-000001', 'A', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const map = buildCostMap(values, 0, 12);
  assert.strictEqual(map.size, 1);
  // 先行行の有効値 100 を後続の無効値 ('') で上書きしない
  assert.strictEqual(map.get('2314-000001'), 100);
});

test('buildCostMap: ヘッダのみ (データ 0 行) → 空 Map', () => {
  const values = [['商品コード', '', '', '', '', '', '', '', '', '', '', '', '原価']];
  const map = buildCostMap(values, 0, 12);
  assert.strictEqual(map.size, 0);
});

test('buildCostMap: values が空/非配列でも例外にならない', () => {
  assert.strictEqual(buildCostMap([], 0, 12).size, 0);
  assert.strictEqual(buildCostMap(null, 0, 12).size, 0);
  assert.strictEqual(buildCostMap(undefined, 0, 12).size, 0);
});

test('buildCostMap: 行の長さが不足で cost 列が undefined → null 扱い', () => {
  const values = [
    ['商品コード', '', '', '', '', '', '', '', '', '', '', '', '原価'],
    ['2314-000001', 'A'], // 列数不足
  ];
  const map = buildCostMap(values, 0, 12);
  assert.strictEqual(map.size, 1);
  assert.strictEqual(map.get('2314-000001'), null);
});

// ============================================================================
// computeStats
// ============================================================================

test('computeStats: 奇数個の中央値', () => {
  assert.deepStrictEqual(computeStats([100, 200, 300]), { min: 100, median: 200, max: 300 });
});

test('computeStats: 偶数個の中央値 (2 数平均を四捨五入)', () => {
  assert.deepStrictEqual(computeStats([100, 200, 300, 400]), { min: 100, median: 250, max: 400 });
});

test('computeStats: 単一要素', () => {
  assert.deepStrictEqual(computeStats([777]), { min: 777, median: 777, max: 777 });
});

test('computeStats: 空配列', () => {
  assert.deepStrictEqual(computeStats([]), { min: 0, median: 0, max: 0 });
});

test('computeStats: null/undefined 入力', () => {
  assert.deepStrictEqual(computeStats(null), { min: 0, median: 0, max: 0 });
  assert.deepStrictEqual(computeStats(undefined), { min: 0, median: 0, max: 0 });
});

test('computeStats: 順不同でもソート後に判定', () => {
  assert.deepStrictEqual(computeStats([500, 100, 300, 200, 400]), { min: 100, median: 300, max: 500 });
});
