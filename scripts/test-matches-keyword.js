#!/usr/bin/env node
// matchesKeyword モード切替の単体テスト
// 使い方: node scripts/test-matches-keyword.js
//
// テスト対象:
//   - デフォルト (and-full): 全 effective token 一致
//   - first-n-tokens (N=3): 先頭 3 token 一致
//   - phrase fallback: 両モードで動作
//   - STOP_WORDS 処理: 両モードで機能語除外
//   - 短keyword (< N tokens): first-n-tokens でも全て一致必要

'use strict';

const FilterService = require('../src/services/FilterService');

const filter = new FilterService();
let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.error(`  ✗ ${name}`); failed++; }
}

// mode を明示的に切り替えて評価するヘルパー
function withMode(mode, firstN, fn) {
  const savedMode = process.env.MATCHES_KEYWORD_MODE;
  const savedN = process.env.MATCHES_KEYWORD_FIRST_N;
  process.env.MATCHES_KEYWORD_MODE = mode;
  if (firstN !== undefined) process.env.MATCHES_KEYWORD_FIRST_N = String(firstN);
  try {
    fn();
  } finally {
    if (savedMode === undefined) delete process.env.MATCHES_KEYWORD_MODE;
    else process.env.MATCHES_KEYWORD_MODE = savedMode;
    if (savedN === undefined) delete process.env.MATCHES_KEYWORD_FIRST_N;
    else process.env.MATCHES_KEYWORD_FIRST_N = savedN;
  }
}

console.log('\n[test-1] デフォルト (and-full) の後方互換性');
delete process.env.MATCHES_KEYWORD_MODE;
delete process.env.MATCHES_KEYWORD_FIRST_N;
assert(filter.matchesKeyword('セノッピー 30粒 ブドウ味 2袋セット', 'セノッピー 30粒') === true,
  'A. 全 token が title に含まれる → pass');
assert(filter.matchesKeyword('セノッピー ブドウ味 2袋セット', 'セノッピー 30粒 ブドウ味') === false,
  'B. 「30粒」が title 欠落 → fail (現状維持)');
assert(filter.matchesKeyword('セノッピーチュアブル', 'セノッピー チュアブル') === true,
  'C. フレーズ一致 (スペース除去後 substring)');

console.log('\n[test-2] MATCHES_KEYWORD_MODE=and-full 明示指定でも同挙動');
withMode('and-full', undefined, () => {
  assert(filter.matchesKeyword('セノッピー ブドウ味 2袋セット', 'セノッピー 30粒 ブドウ味') === false,
    'A. and-full 明示: 「30粒」欠落 → fail');
  assert(filter.matchesKeyword('セノッピー 30粒 ブドウ味 セット', 'セノッピー 30粒 ブドウ味') === true,
    'B. and-full 明示: 全 token 揃う → pass');
});

console.log('\n[test-3] first-n-tokens (N=3) モード');
withMode('first-n-tokens', 3, () => {
  // 4-token keyword で 3-token 目まで揃えば pass
  assert(filter.matchesKeyword('セノッピー 30粒 ブドウ味 何か', 'セノッピー 30粒 ブドウ味 2袋セット') === true,
    'A. 4tok kw、先頭3tok揃い、4tok目 (2袋セット) 欠落 → pass');
  // 3-token 目が欠落したら fail
  assert(filter.matchesKeyword('セノッピー 30粒 その他', 'セノッピー 30粒 ブドウ味 2袋セット') === false,
    'B. 4tok kw、3tok目 (ブドウ味) 欠落 → fail');
});

console.log('\n[test-4] first-n-tokens (N=2) モード');
withMode('first-n-tokens', 2, () => {
  assert(filter.matchesKeyword('セノッピー 30粒 何か', 'セノッピー 30粒 ブドウ味 2袋セット') === true,
    'A. N=2: 先頭2tok揃い → pass');
  assert(filter.matchesKeyword('セノッピー 何か', 'セノッピー 30粒 ブドウ味') === false,
    'B. N=2: 2tok目 (30粒) 欠落 → fail');
});

console.log('\n[test-5] 短 keyword (tokens 数 < N) の挙動');
withMode('first-n-tokens', 3, () => {
  // 2-token keyword で N=3 の場合、slice(0, 3) は 2件、実質 and-full と同じ
  assert(filter.matchesKeyword('セノッピー チュアブル', 'セノッピー チュアブル') === true,
    'A. 2tok kw、N=3: 全 token 一致 → pass');
  assert(filter.matchesKeyword('セノッピー 何か', 'セノッピー チュアブル') === false,
    'B. 2tok kw、N=3: 2tok目欠落 → fail (実質 and-full と同じ)');
});

console.log('\n[test-6] STOP_WORDS 処理 (両モードで機能語除外)');
withMode('and-full', undefined, () => {
  assert(filter.matchesKeyword('risou coffee 30', 'risou no Coffee 30') === true,
    'A. and-full: "no" は STOP_WORD なので "risou coffee 30" で pass');
});
withMode('first-n-tokens', 3, () => {
  assert(filter.matchesKeyword('risou coffee 何か', 'risou no Coffee 30') === false,
    'B. first-n-tokens N=3: STOP_WORD除外後 effective=[risou, coffee, 30]、'
    + '「30」欠落 → fail');
  assert(filter.matchesKeyword('risou coffee 30', 'risou no Coffee 30') === true,
    'C. first-n-tokens N=3: STOP_WORD除外後 全3 tok一致 → pass');
});

console.log('\n[test-7] フレーズ一致 (両モードで安全網)');
withMode('and-full', undefined, () => {
  assert(filter.matchesKeyword('セノッピーチュアブル', 'セノッピー チュアブル') === true,
    'A. and-full: スペースなしタイトルで phrase 一致 → pass');
});
withMode('first-n-tokens', 3, () => {
  assert(filter.matchesKeyword('セノッピーチュアブル', 'セノッピー チュアブル') === true,
    'B. first-n-tokens: 同じくphrase一致で pass');
  // AND判定は 「セノッピー」「チュアブル」が別々に含まれる必要あり、フレーズだと 1文字列で OK
  assert(filter.matchesKeyword('セノッピー30粒ブドウ味2袋セット', 'セノッピー 30粒 ブドウ味 2袋セット') === true,
    'C. 4tok kw、スペースなしタイトルで phrase 一致 → pass');
});

console.log('\n[test-8] Case D 想定シナリオ (id=81 の元 4tok kw を復元して検証)');
withMode('and-full', undefined, () => {
  // 元 id=81 kw: "セノッピー 30粒 ブドウ味 2袋セット"
  // Case D で拾ったが filter 弾きだった title を再現
  assert(filter.matchesKeyword(
    '即日発送　セノッピー グミ 2袋セット ブドウ味 りんご味',
    'セノッピー 30粒 ブドウ味 2袋セット'
  ) === false, 'A. and-full: 「30粒」欠落タイトル → fail (Case D 実測通り)');
});
withMode('first-n-tokens', 3, () => {
  // N=3 では 「セノッピー」「30粒」「ブドウ味」が必要、まだ「30粒」欠落なので fail
  assert(filter.matchesKeyword(
    '即日発送　セノッピー グミ 2袋セット ブドウ味 りんご味',
    'セノッピー 30粒 ブドウ味 2袋セット'
  ) === false, 'B. first-n-tokens N=3: 「30粒」欠落は依然 fail (N=3 でも救えない)');
  // N=3 で救えるケース: 「2袋セット」欠落 title
  assert(filter.matchesKeyword(
    'セノッピー 30粒 ブドウ味 単品',
    'セノッピー 30粒 ブドウ味 2袋セット'
  ) === true, 'C. first-n-tokens N=3: 4tok目 (2袋セット) 欠落だが 3tok揃い → pass');
});

console.log('\n[test-9] MATCHES_KEYWORD_FIRST_N 環境変数の反映');
withMode('first-n-tokens', 1, () => {
  assert(filter.matchesKeyword('セノッピー 何か 何か', 'セノッピー 30粒 ブドウ味 2袋セット') === true,
    'A. N=1: 先頭1tokのみ一致で pass');
});
withMode('first-n-tokens', 4, () => {
  assert(filter.matchesKeyword('セノッピー 30粒 ブドウ味 2袋セット 追加', 'セノッピー 30粒 ブドウ味 2袋セット') === true,
    'A. N=4: 4tok全て一致で pass');
  assert(filter.matchesKeyword('セノッピー 30粒 ブドウ味 何か', 'セノッピー 30粒 ブドウ味 2袋セット') === false,
    'B. N=4: 4tok目欠落で fail');
});

console.log('\n=== 結果 ===');
console.log(`passed=${passed}, failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
