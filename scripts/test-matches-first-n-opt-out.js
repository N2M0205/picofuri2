#!/usr/bin/env node
// FilterService.matchesKeyword の Cold first-n opt-out ロジックのユニットテスト
// (2026-08-11 案A、feat/matches-opt-out-list)
//
// 検証:
//   - opt-out リスト内 keywordId は tier=cold でも and-full 判定になる
//   - opt-out リスト外 keywordId は tier=cold で first-n 判定になる (既存挙動維持)
//   - keywordId 未指定 (旧テスト互換) は tier=cold で first-n (既存挙動維持)
//   - env MATCHES_KEYWORD_MODE=first-n-tokens は opt-out を無視して first-n を強制
//   - Hot/Warm は opt-out 有無に関わらず and-full (既存挙動維持)

'use strict';

const FilterService = require('../src/services/FilterService');
const { FIRST_N_OPT_OUT_KEYWORD_IDS } = require('../src/config/matchesKeywordFirstNOptOut.js');

const filter = new FilterService();
let passed = 0, failed = 0;

function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

// 4-token キーワード「N organic Vie モイストリッチ」を使ってテスト
// - and-full 判定: 「N organic Vie モイストリッチ」を全て含むタイトルのみ true
// - first-n=3 判定: 「N organic Vie」を全て含むタイトルは true (モイストリッチが無くても)
const kw4 = 'N organic Vie モイストリッチ';
const titleFullMatch = 'N organic Vie モイストリッチ 100ml 新品';       // 両方 true
const titleFirstNOnly = 'N organic Vie バリアクリーム 47g 新品';        // first-n=true, and-full=false
const titleNoMatch = 'ドクターワンデル プラス 30ml';                    // 両方 false

console.log('[baseline] opt-out set contains 13 IDs:',
  FIRST_N_OPT_OUT_KEYWORD_IDS.size);
assert(FIRST_N_OPT_OUT_KEYWORD_IDS.size === 13, 'opt-out set size = 13');
assert(FIRST_N_OPT_OUT_KEYWORD_IDS.has(139), '  contains id=139 (N organic Vie モイストリッチ)');
assert(FIRST_N_OPT_OUT_KEYWORD_IDS.has(150), '  contains id=150 (SHIRORU クリスタルホイップ)');
assert(!FIRST_N_OPT_OUT_KEYWORD_IDS.has(189), '  excludes id=189 (Ｎ organic、意図的に維持)');
assert(!FIRST_N_OPT_OUT_KEYWORD_IDS.has(193), '  excludes id=193 (エヌ オーガニック、意図的に維持)');

console.log('\n[test-A] opt-out キーワード (id=139) は tier=cold でも and-full');
assert(filter.matchesKeyword(titleFullMatch, kw4, { tier: 'cold', keywordId: 139 }) === true,
  'fullMatch title は true');
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { tier: 'cold', keywordId: 139 }) === false,
  'firstN-only title は false (opt-out で and-full 適用)');
assert(filter.matchesKeyword(titleNoMatch, kw4, { tier: 'cold', keywordId: 139 }) === false,
  'noMatch title は false');

console.log('\n[test-B] opt-out 外キーワード (id=999) は tier=cold で first-n');
assert(filter.matchesKeyword(titleFullMatch, kw4, { tier: 'cold', keywordId: 999 }) === true,
  'fullMatch title は true');
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { tier: 'cold', keywordId: 999 }) === true,
  'firstN-only title は true (first-n 適用で救済)');
assert(filter.matchesKeyword(titleNoMatch, kw4, { tier: 'cold', keywordId: 999 }) === false,
  'noMatch title は false');

console.log('\n[test-C] keywordId 未指定 (旧テスト互換) は tier=cold で first-n');
assert(filter.matchesKeyword(titleFullMatch, kw4, { tier: 'cold' }) === true,
  'fullMatch title は true');
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { tier: 'cold' }) === true,
  'firstN-only title は true (keywordId 未指定なので first-n)');

console.log('\n[test-D] Hot/Warm tier は opt-out 有無に関わらず and-full');
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { tier: 'hot', keywordId: 999 }) === false,
  'hot + opt-out 外 → and-full なので false');
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { tier: 'warm', keywordId: 999 }) === false,
  'warm + opt-out 外 → and-full なので false');
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { tier: 'hot', keywordId: 139 }) === false,
  'hot + opt-out 内 → and-full なので false');

console.log('\n[test-E] env MATCHES_KEYWORD_MODE=first-n-tokens は opt-out を無視');
const prevMode = process.env.MATCHES_KEYWORD_MODE;
process.env.MATCHES_KEYWORD_MODE = 'first-n-tokens';
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { tier: 'hot', keywordId: 139 }) === true,
  'env override 中は opt-out 内でも first-n (グローバル override 優先)');
if (prevMode !== undefined) process.env.MATCHES_KEYWORD_MODE = prevMode;
else delete process.env.MATCHES_KEYWORD_MODE;

console.log('\n[test-F] tier 未指定 (cron 直呼び等) は and-full (既存挙動)');
assert(filter.matchesKeyword(titleFirstNOnly, kw4, { keywordId: 139 }) === false,
  'tier 未指定 → and-full');
assert(filter.matchesKeyword(titleFirstNOnly, kw4) === false,
  'opts 全省略 → and-full');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
