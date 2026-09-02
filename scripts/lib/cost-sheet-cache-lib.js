// scripts/lib/cost-sheet-cache-lib.js
// fetch-cost-sheet.js の純粋関数レイヤ。DB・Sheets API に依存せず、テスト可能。

'use strict';

const MONITORED_SHEET_COLUMN = 12;      // M 列 = 「原価」 (0-index、A=0)
const INVENTORY_ITEM_CODE_COLUMN = 0;   // A 列 = 「商品コード」
const RETENTION_DAYS = 3;

// シートの原価セル値を整数に正規化。無効なら null。
// 許容: 数値、"1234"、"1,234"、"1234.0" (先頭スペース含む可)、"12円" は不許容 (数字以外含む)
function parseCost(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.trunc(raw);
  }
  const s = String(raw).replace(/[,\s]/g, '');
  if (s === '') return null;
  // 数字と最大 1 個の小数点、先頭 - を許容
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

// 2 次元配列 (Sheet values) から Map<code, cost|null> を構築。
// 1 行目 (index 0) はヘッダとしてスキップ。
// itemCode が空/未定義の行はスキップ。cost 列が無効なら Map に null 格納
// (呼び出し側で 「シート行はあるが M 列が空・非数値」を区別可能にする)。
function buildCostMap(values, itemCodeCol, costCol) {
  const map = new Map();
  if (!Array.isArray(values) || values.length < 2) return map;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!Array.isArray(row)) continue;
    const code = row[itemCodeCol];
    if (code === undefined || code === null || code === '') continue;
    const cost = parseCost(row[costCol]);
    // 同じ code が複数行ある場合は「有効な cost があれば優先」、
    // 両方無効なら最後の null を維持
    if (map.has(code)) {
      const prev = map.get(code);
      if (prev !== null && cost === null) continue; // 既に有効値、無効値で上書きしない
    }
    map.set(String(code), cost);
  }
  return map;
}

// 数値配列の min / median / max を計算。空配列なら 0/0/0。
function computeStats(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = nums.slice().sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
  return { min, median, max };
}

module.exports = {
  parseCost,
  buildCostMap,
  computeStats,
  MONITORED_SHEET_COLUMN,
  INVENTORY_ITEM_CODE_COLUMN,
  RETENTION_DAYS,
};
