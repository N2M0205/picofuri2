#!/usr/bin/env node
// YAHOO_KEYWORD_ALLOWLIST の OR 構文対応 単体テスト
// 2026-08-31 追加、fix/yahoo-allowlist-or-syntax
//
// 検証:
//   (a) 従来の単一 keyword が引き続き allowlist で正しくマッチする
//   (b) OR 構文 keyword のうち 1 バリアントが allowlist に一致すれば true
//       (id=2 "ToyLaBO,トイラボ" のケースの再現)
//   (c) どのバリアントも一致しない場合は false
//   (d) パイプ区切り (半角/全角) にも対応
//   (e) 空バリアント (連続区切り) は無視

'use strict';

// ScrapingService.js:230-236 の filter ロジックと同一を再現
// (関数として抽出できないインライン実装のため、テストではロジックを複製検証)
function isKeywordAllowed(keyword, allowlist) {
  return (keyword || '')
    .split(/[,|｜]/)
    .some(v => allowlist.includes(v.trim()));
}

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

const allowlist = ['ToyLaBO', 'さかな暮らし'];

console.log('\n[test-a] 従来の単一 keyword が正しくマッチする (後方互換)');
assert(isKeywordAllowed('ToyLaBO', allowlist) === true,
  'A1. "ToyLaBO" (単体) → true');
assert(isKeywordAllowed('さかな暮らし', allowlist) === true,
  'A2. "さかな暮らし" (単体) → true');
assert(isKeywordAllowed('未登録キーワード', allowlist) === false,
  'A3. 一致しない単一 keyword → false (既存動作維持)');

console.log('\n[test-b] OR 構文 keyword のうち 1 バリアントが allowlist に一致 (id=2 のケース)');
assert(isKeywordAllowed('ToyLaBO,トイラボ', allowlist) === true,
  'B1. "ToyLaBO,トイラボ" → true (先頭バリアント一致)');
assert(isKeywordAllowed('トイラボ,ToyLaBO', allowlist) === true,
  'B2. "トイラボ,ToyLaBO" → true (末尾バリアント一致)');
assert(isKeywordAllowed('別の商品,ToyLaBO,雑貨', allowlist) === true,
  'B3. "別の商品,ToyLaBO,雑貨" → true (中間バリアント一致)');
assert(isKeywordAllowed('魚,さかな暮らし', allowlist) === true,
  'B4. "魚,さかな暮らし" → true (2件目 allowlist が一致)');

console.log('\n[test-c] どのバリアントも allowlist に一致しない → false');
assert(isKeywordAllowed('未登録A,未登録B', allowlist) === false,
  'C1. どちらも allowlist にない → false');
assert(isKeywordAllowed('ToyLaBO2,ToyLaBOX', allowlist) === false,
  'C2. 類似だが完全一致しないバリアント → false');
assert(isKeywordAllowed('', allowlist) === false,
  'C3. 空 keyword → false (バリアント無し)');

console.log('\n[test-d] パイプ区切り (半角/全角) にも対応 (matchesKeyword と同じ分割記号)');
assert(isKeywordAllowed('ToyLaBO|トイラボ', allowlist) === true,
  'D1. "ToyLaBO|トイラボ" (半角パイプ) → true');
assert(isKeywordAllowed('トイラボ｜ToyLaBO', allowlist) === true,
  'D2. "トイラボ｜ToyLaBO" (全角パイプ) → true');
assert(isKeywordAllowed('ToyLaBO|さかな暮らし', allowlist) === true,
  'D3. パイプで異なる allowlist 両方に一致 → true');
assert(isKeywordAllowed('kw1|kw2,kw3｜さかな暮らし', allowlist) === true,
  'D4. 3種混在で 1バリアント一致 → true');
assert(isKeywordAllowed('kw1|kw2,kw3｜kw4', allowlist) === false,
  'D5. 3種混在で全バリアント不一致 → false');

console.log('\n[test-e] 空バリアント (連続区切り) は無視');
assert(isKeywordAllowed('ToyLaBO,,トイラボ', allowlist) === true,
  'E1. カンマ連続 (空バリアント混入) でも一致確認');
assert(isKeywordAllowed(',,,ToyLaBO', allowlist) === true,
  'E2. 先頭空バリアント連続 でも一致確認');
assert(isKeywordAllowed('ToyLaBO|', allowlist) === true,
  'E3. 末尾空バリアント でも一致確認');
assert(isKeywordAllowed(',,,', allowlist) === false,
  'E4. 全バリアント空 → false');

console.log('\n[test-f] trim (前後空白) 対応');
assert(isKeywordAllowed('ToyLaBO, トイラボ', allowlist) === true,
  'F1. カンマ後 半角スペース → trim で一致');
assert(isKeywordAllowed('  ToyLaBO  ,  トイラボ  ', allowlist) === true,
  'F2. 前後空白 → trim で一致');

console.log('\n=== 結果 ===');
console.log(`passed=${passed}, failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
