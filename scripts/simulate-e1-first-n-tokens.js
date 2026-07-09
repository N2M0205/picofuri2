#!/usr/bin/env node
// Task 6 (案E-1): matchesKeyword を「先頭N tok一致」に変更した場合の通過率シミュレーション
//
// 現行 (FilterService.matchesKeyword):
//   全 effective tokens (STOP_WORDS 除外後) が title に含まれるか AND判定
//   OR フレーズ一致 (スペース除去後)
//
// 案E-1:
//   先頭 N tokens のみを AND判定 (N=2, 3 の 2 パターン)
//   フレーズ一致は現状維持 (安全網)
//
// 出力:
//   - 静的分析: 226 kw の有効トークン数分布、影響 kw 数
//   - 動的分析: 戦略的サンプル (StarredOos 15件 + Warm/Cold 抽出) で Mercari 呼び出し、
//     current vs N=2 vs N=3 の通過数比較
//   - false positive リスク: N=2/N=3 で追加通過するアイテムのタイトル抽出
//
// 読み取り専用、DB書込みなし。

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');
const MercariApiScraper = require('../src/scrapers/MercariApiScraper');
const FilterService = require('../src/services/FilterService');
const TierClassifier = require('../src/services/TierClassifier');

const STOP_WORDS = ['no', 'the', 'for', 'and', 'with', 'from', 'de', 'la', 'le'];

function normalize(str) {
  return str
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[+＋]/g, 'プラス')
    .replace(/[^\w぀-ヿ一-鿿　-〿 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function effectiveTokens(keyword) {
  return normalize(keyword).split(/\s+/).filter(w => w && !STOP_WORDS.includes(w));
}

// current 実装 (frontier check)
function matchesCurrent(title, keyword) {
  const normTitle = normalize(title);
  const words = effectiveTokens(keyword);
  if (words.length === 0) return true;
  if (words.every(w => normTitle.includes(w))) return true;
  const phraseTitle = normTitle.replace(/\s/g, '');
  const phraseKeyword = normalize(keyword).replace(/\s/g, '');
  if (phraseTitle.includes(phraseKeyword)) return true;
  return false;
}

// 案E-1: 先頭N tok一致 (+ フレーズ一致は現状維持)
function matchesFirstN(title, keyword, n) {
  const normTitle = normalize(title);
  const words = effectiveTokens(keyword);
  if (words.length === 0) return true;
  const first = words.slice(0, n);
  if (first.every(w => normTitle.includes(w))) return true;
  const phraseTitle = normTitle.replace(/\s/g, '');
  const phraseKeyword = normalize(keyword).replace(/\s/g, '');
  if (phraseTitle.includes(phraseKeyword)) return true;
  return false;
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const all = await Keyword.findAll({
    where: { isActive: true },
    order: [['id', 'ASC']],
    raw: true,
  });
  const filter = new FilterService();

  console.log('=== Task 6: 案E-1 先頭N tok一致 dry-run ===');
  console.log(`  対象: 全 ${all.length} kw (isActive=1)`);
  console.log(``);

  // === Phase 1: 静的分析 ===
  console.log('=== Phase 1: 有効トークン数の分布 (STOP_WORDS 除外後) ===');
  const byTokCount = {};
  for (const kw of all) {
    const c = effectiveTokens(kw.keyword).length;
    byTokCount[c] = (byTokCount[c] || 0) + 1;
  }
  for (const [n, cnt] of Object.entries(byTokCount).sort((a, b) => +a[0] - +b[0])) {
    console.log(`  ${n} tok: ${cnt}件`);
  }
  const affectedByN2 = all.filter(k => effectiveTokens(k.keyword).length >= 3).length;
  const affectedByN3 = all.filter(k => effectiveTokens(k.keyword).length >= 4).length;
  console.log('');
  console.log(`  N=2 で影響を受ける kw (effective tok >= 3): ${affectedByN2}件`);
  console.log(`  N=3 で影響を受ける kw (effective tok >= 4): ${affectedByN3}件`);
  console.log('');

  // 影響 kw の内訳を tier 別に
  const classes = await TierClassifier.classifyAll();
  const tierOf = new Map();
  for (const t of ['hot', 'warm', 'cold', 'starredOos']) {
    for (const k of (classes[t] || [])) tierOf.set(k.id, t);
  }
  console.log('=== N=2/N=3 で影響を受ける kw の tier 分布 ===');
  const affected2 = all.filter(k => effectiveTokens(k.keyword).length >= 3);
  const affected3 = all.filter(k => effectiveTokens(k.keyword).length >= 4);
  const byTierN2 = {};
  const byTierN3 = {};
  for (const k of affected2) {
    const t = tierOf.get(k.id) || '?';
    byTierN2[t] = (byTierN2[t] || 0) + 1;
  }
  for (const k of affected3) {
    const t = tierOf.get(k.id) || '?';
    byTierN3[t] = (byTierN3[t] || 0) + 1;
  }
  console.log('  N=2 影響 tier:');
  for (const [t, n] of Object.entries(byTierN2)) console.log(`    ${t}: ${n}件`);
  console.log('  N=3 影響 tier:');
  for (const [t, n] of Object.entries(byTierN3)) console.log(`    ${t}: ${n}件`);
  console.log('');

  // === Phase 2: 動的分析 (Mercari 呼び出し) ===
  // サンプル: StarredOos 全15件 + Warm 全19件 + Cold で eff-tok >=3 のうち上位 10件
  const scraper = new MercariApiScraper();
  await scraper.initialize();

  const starredIds = new Set(classes.starredOos.map(k => k.id));
  const warmIds = new Set(classes.warm.map(k => k.id));
  const coldIds = new Set(classes.cold.map(k => k.id));
  const sampleKws = [];
  for (const k of all) {
    if (starredIds.has(k.id) || warmIds.has(k.id)) sampleKws.push(k);
  }
  const coldEff3 = all.filter(k => coldIds.has(k.id) && effectiveTokens(k.keyword).length >= 3);
  // Cold 抽出は最初の 10件 (id 昇順)
  sampleKws.push(...coldEff3.slice(0, 10));

  console.log(`=== Phase 2: 動的分析 (Mercari 呼び出し、サンプル ${sampleKws.length} kw) ===`);
  console.log(`  内訳: StarredOos ${starredIds.size}件 + Warm ${warmIds.size}件 + Cold 上位10件`);
  console.log('');

  // 集計
  let totalItems = 0;
  let currentPass = 0;
  let n2Pass = 0;
  let n3Pass = 0;
  const addedByN2 = []; // {kw, item.title}
  const addedByN3 = []; // {kw, item.title}
  const removedByN2 = []; // Should never happen since N=2 is more permissive

  for (const kw of sampleKws) {
    const eTokens = effectiveTokens(kw.keyword);
    if (eTokens.length < 3) continue; // N=2/N=3 と currentが同じなのでスキップ
    let items;
    try {
      items = await scraper.search(kw.keyword);
    } catch (e) {
      console.warn(`  [Mercari エラー] id=${kw.id} "${kw.keyword}": ${e.message}`);
      continue;
    }
    for (const item of items) {
      totalItems++;
      const mCur = matchesCurrent(item.title, kw.keyword);
      const mN2  = matchesFirstN(item.title, kw.keyword, 2);
      const mN3  = matchesFirstN(item.title, kw.keyword, 3);
      if (mCur) currentPass++;
      if (mN2)  n2Pass++;
      if (mN3)  n3Pass++;
      // LayerA 通過も評価
      const layer = filter.check(item, kw);
      if (mN2 && !mCur && layer.pass) addedByN2.push({ id: kw.id, kw: kw.keyword, title: item.title, eTokens });
      if (mN3 && !mCur && layer.pass) addedByN3.push({ id: kw.id, kw: kw.keyword, title: item.title, eTokens });
    }
  }

  console.log(`=== 集計 (サンプル、eff-tok>=3 の kw のみ) ===`);
  console.log(`  Mercari 総返却 items: ${totalItems}`);
  console.log(`  current 通過: ${currentPass}件 (${Math.round(currentPass/totalItems*100)}%)`);
  console.log(`  案E-1 N=2 通過: ${n2Pass}件 (${Math.round(n2Pass/totalItems*100)}%) [差分 +${n2Pass-currentPass}件]`);
  console.log(`  案E-1 N=3 通過: ${n3Pass}件 (${Math.round(n3Pass/totalItems*100)}%) [差分 +${n3Pass-currentPass}件]`);
  console.log('');

  // N=3 で追加通過するアイテム (LayerA 通過後)
  console.log(`=== 案E-1 N=3 で追加通過するアイテム (${addedByN3.length}件) ===`);
  console.log(`  (LayerA も通過するもののみ)`);
  const grouped3 = {};
  for (const a of addedByN3) {
    if (!grouped3[a.id]) grouped3[a.id] = { kw: a.kw, titles: [], eTokens: a.eTokens };
    grouped3[a.id].titles.push(a.title);
  }
  for (const [id, g] of Object.entries(grouped3)) {
    console.log(`  id=${id} "${g.kw}" [effective tokens: ${g.eTokens.join('|')}]`);
    for (const t of g.titles.slice(0, 5)) console.log(`    + "${t}"`);
    if (g.titles.length > 5) console.log(`    ... ${g.titles.length - 5} more`);
  }
  console.log('');

  // N=2 で追加通過するアイテム
  console.log(`=== 案E-1 N=2 で追加通過するアイテム (${addedByN2.length}件、N=3差分含む) ===`);
  console.log(`  (LayerA も通過するもののみ)`);
  const grouped2 = {};
  for (const a of addedByN2) {
    if (!grouped2[a.id]) grouped2[a.id] = { kw: a.kw, titles: [], eTokens: a.eTokens };
    grouped2[a.id].titles.push(a.title);
  }
  for (const [id, g] of Object.entries(grouped2)) {
    console.log(`  id=${id} "${g.kw}" [effective tokens: ${g.eTokens.join('|')}]`);
    for (const t of g.titles.slice(0, 5)) console.log(`    + "${t}"`);
    if (g.titles.length > 5) console.log(`    ... ${g.titles.length - 5} more`);
  }
  console.log('');

  // false positive リスク kw の特定 (2tok にすると多くの他 SKU と重なる kw)
  console.log(`=== false positive リスク kw (2tok化で他 SKU/ラインナップと衝突) ===`);
  const firstTwoMap = new Map(); // "tok1 tok2" -> [ids]
  for (const kw of all) {
    const t = effectiveTokens(kw.keyword);
    if (t.length >= 2) {
      const key = t.slice(0, 2).join(' ');
      if (!firstTwoMap.has(key)) firstTwoMap.set(key, []);
      firstTwoMap.get(key).push({ id: kw.id, kw: kw.keyword });
    }
  }
  const collisions2 = [...firstTwoMap.entries()].filter(([, arr]) => arr.length > 1);
  console.log(`  先頭2 tok が重複するグループ数: ${collisions2.length}`);
  for (const [key, arr] of collisions2.sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    console.log(`  "${key}" → ${arr.length}件が同一先頭2tok:`);
    for (const item of arr) console.log(`    id=${item.id} "${item.kw}"`);
  }
  console.log('');

  console.log(`=== 所見 ===`);
  console.log(`  N=2: 通過率大幅UP (+${Math.round((n2Pass-currentPass)/totalItems*100)}%pt)、`
    + `${collisions2.length}グループの先頭2tok衝突あり → 誤検知リスク高`);
  console.log(`  N=3: 通過率中UP (+${Math.round((n3Pass-currentPass)/totalItems*100)}%pt)、`
    + `4tok kw のみ影響、衝突リスク低`);
  console.log(`  推奨: まず N=3 を導入し、効果を測って必要なら N=2 に移行するのが安全`);

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
