#!/usr/bin/env node
// Test: FilterService.check の 商品状態フィルタ (2026-09-02 追加)
//
// カバレッジ:
//   - cid="1" (新品、未使用) → pass
//   - cid="2"〜"6" → NG (reason に itemConditionId 表示)
//   - itemConditionId undefined → fail-open (pass)
//   - itemConditionId null → fail-open (pass)
//   - Yahoo item (itemConditionId 未設定) → fail-open (pass)
//   - 商品状態以外の既存フィルタ (下限価格・NG語句) との組合せ動作確認
//
// 使い方: node scripts/test-item-condition-filter.js
// 期待: 全 assert PASS で exit 0、いずれか失敗で exit 1

'use strict';

const FilterService = require('../src/services/FilterService.js');
const svc = new FilterService();

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else      { fail++; console.log('  FAIL:', msg); }
}

// ダミー Keyword: minPrice=0, maxPrice=999999 で価格・NG フィルタは通過
const kwBase = {
  id: 1,
  keyword: 'テスト',
  minPrice: 0,
  maxPrice: 999999,
  excludeKeywords: '',
  globalExcludeEnabled: true,
};

function makeItem(overrides) {
  return {
    title: 'テスト商品 本物',
    price: 1000,
    listedAt: null,
    platform: 'mercari',
    ...overrides,
  };
}

console.log('=== 商品状態フィルタ (item_condition) ===');

// (1) cid="1" → pass
{
  const r = svc.check(makeItem({ itemConditionId: '1' }), kwBase);
  assert(r.pass === true, 'cid="1" (新品、未使用) は通過');
  assert(r.reason === null, 'cid="1" 通過時 reason=null');
}

// (2) cid="2"〜"6" → 全て NG
for (const cid of ['2', '3', '4', '5', '6']) {
  const r = svc.check(makeItem({ itemConditionId: cid }), kwBase);
  assert(r.pass === false, `cid="${cid}" は NG`);
  assert(r.reason && r.reason.includes(`itemConditionId="${cid}"`),
    `cid="${cid}" reason に "${cid}" を含む`);
}

// (3) undefined → fail-open
{
  const r = svc.check(makeItem({ itemConditionId: undefined }), kwBase);
  assert(r.pass === true, 'itemConditionId=undefined は通過 (fail-open)');
}

// (4) null → fail-open
{
  const r = svc.check(makeItem({ itemConditionId: null }), kwBase);
  assert(r.pass === true, 'itemConditionId=null は通過 (fail-open)');
}

// (5) Yahoo item (フィールド未設定) → fail-open
{
  const yahooItem = makeItem({ platform: 'yahoo_flea' });  // no itemConditionId
  const r = svc.check(yahooItem, kwBase);
  assert(r.pass === true, 'Yahoo item (itemConditionId 未設定) は通過');
}

// (6) 空文字 "" → fail-open (Mercari API から空返却時の safety)
{
  const r = svc.check(makeItem({ itemConditionId: '' }), kwBase);
  assert(r.pass === true, 'itemConditionId="" は通過 (fail-open、空返却safety)');
}

// (7) 数値 1 (string ではなく number) → fail-open にはならず NG になる
//     Mercari API は string "1" を返す仕様のため、number は「型が違う異常値」
//     → 現行実装では !== '1' で NG 側に倒す (fail-close だが、上位で型検証
//       の warning が期待されるため許容)。この挙動を明示テスト。
{
  const r = svc.check(makeItem({ itemConditionId: 1 }), kwBase);
  assert(r.pass === false, 'itemConditionId=1 (number) は NG (型不一致、fail-close)');
}

console.log('\n=== 既存フィルタとの組合せ (regression) ===');

// (8) cid="1" + 下限価格未満 → 下限価格 NG が優先 (order 保持確認)
{
  const kw = { ...kwBase, minPrice: 5000 };
  const r = svc.check(makeItem({ itemConditionId: '1', price: 1000 }), kw);
  assert(r.pass === false && r.reason.includes('下限価格'),
    '下限価格 NG は 商品状態より前 (順序保持)');
}

// (9) cid="2" + タイトルに "空箱" (グローバル除外) → 商品状態 NG が優先
//     商品状態 (step 4) はグローバル除外 (step 6) より前のため
{
  const r = svc.check(makeItem({ itemConditionId: '2', title: '空箱テスト' }), kwBase);
  assert(r.pass === false && r.reason.includes('itemConditionId'),
    '商品状態 NG はグローバル除外より前 (順序保持)');
}

// (10) 全通過ケース: cid="1"、価格範囲内、NG 語なし
{
  const kw = { ...kwBase, minPrice: 500, maxPrice: 2000 };
  const r = svc.check(makeItem({ itemConditionId: '1', price: 1500, title: '普通の商品' }), kw);
  assert(r.pass === true && r.reason === null, '全条件通過ケース');
}

console.log(`\n=== 結果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
