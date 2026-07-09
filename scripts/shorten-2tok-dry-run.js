#!/usr/bin/env node
// Task 3 (案A): KEEP_TOKENS=2 での全 227 kw 短縮 dry-run
//
// 前回 (2026-07-07) は id>77 の新規 157件のみ対象・KEEP_TOKENS=4 (D の 108件は 3tok, A の 10件は 4tok)
// 今回は Case D の実データ検証を受け「Mercari は AND完全一致ではなく緩い部分マッチ」と判明したため、
// filter.matchesKeyword の AND 判定を通しやすくするため全 kw を 2tok に短縮する検討。
//
// DB 書き込みなし。owner 判断待ちで停止すること。

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');
const TierClassifier = require('../src/services/TierClassifier');

const KEEP_TOKENS = 2;

function tokenize(s) {
  return s.split(/[\s　]+/).filter(Boolean);
}
function shorten(kw, n = KEEP_TOKENS) {
  return tokenize(kw).slice(0, n).join(' ');
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const all = await Keyword.findAll({
    order: [['id', 'ASC']],
    attributes: ['id', 'keyword', 'crossmallItemCode'],
    raw: true,
  });

  console.log('=== Task 3: 2-token 短縮 dry-run ===');
  console.log(`  対象: 全 ${all.length}件`);
  console.log(`  KEEP_TOKENS = ${KEEP_TOKENS}`);
  console.log('');

  // TierClassifier で StarredOos を特定
  const classes = await TierClassifier.classifyAll();
  const starredOosIds = new Set((classes.starredOos || []).map(k => k.id));
  const hotIds = new Set(classes.hot.map(k => k.id));
  const warmIds = new Set(classes.warm.map(k => k.id));
  const coldIds = new Set(classes.cold.map(k => k.id));
  console.log(`  Tier: hot=${classes.hot.length} warm=${classes.warm.length} ` +
    `cold=${classes.cold.length} starredOos=${classes.starredOos?.length || 0}`);
  console.log('');

  // 各 kw の短縮案
  const plan = new Map(); // id -> { id, old, new, tokens_old, tokens_new, tier }
  for (const kw of all) {
    const tokensOld = tokenize(kw.keyword);
    const shortForm = shorten(kw.keyword, KEEP_TOKENS);
    const tokensNew = tokenize(shortForm);
    let tier = '?';
    if (hotIds.has(kw.id)) tier = 'hot';
    else if (warmIds.has(kw.id)) tier = 'warm';
    else if (starredOosIds.has(kw.id)) tier = 'starredOos';
    else if (coldIds.has(kw.id)) tier = 'cold';
    plan.set(kw.id, {
      id: kw.id,
      old: kw.keyword,
      new: shortForm,
      tokens_old: tokensOld.length,
      tokens_new: tokensNew.length,
      tier,
    });
  }

  // 分類
  const changed = [...plan.values()].filter(p => p.new !== p.old);
  const noChange = [...plan.values()].filter(p => p.new === p.old);
  const oneTokenShort = changed.filter(p => p.tokens_new === 1);
  const twoTokenShort = changed.filter(p => p.tokens_new === 2);

  console.log('=== 短縮対象件数 ===');
  console.log(`  変更対象: ${changed.length}件 (${Math.round(changed.length/all.length*100)}%)`);
  console.log(`  変更なし: ${noChange.length}件 (元が 1-2 tokens、既に短い)`);
  console.log(`  ─ 短縮後 2tok: ${twoTokenShort.length}件`);
  console.log(`  ─ 短縮後 1tok: ${oneTokenShort.length}件 (元が 1tok の kw = 短縮不要と実質同じ)`);
  console.log('');

  // 衝突検出
  const finalMap = new Map();
  for (const [id, p] of plan.entries()) {
    if (!finalMap.has(p.new)) finalMap.set(p.new, []);
    finalMap.get(p.new).push(id);
  }
  const collisions = [...finalMap.entries()].filter(([, ids]) => ids.length > 1);

  console.log('=== 衝突検出 ===');
  console.log(`  衝突グループ数: ${collisions.length}`);
  console.log(`  影響 kw 数: ${collisions.reduce((s, [, ids]) => s + ids.length, 0)}件`);
  console.log('');

  // 衝突詳細
  if (collisions.length > 0) {
    console.log('=== 衝突詳細 (グループ別) ===');
    for (const [key, ids] of collisions.sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n"${key}" → ${ids.length}件が同一化`);
      for (const id of ids) {
        const p = plan.get(id);
        const changeMark = p.new === p.old ? '(元と同じ)' : '';
        console.log(`  id=${String(id).padStart(3)} [${p.tier}] "${p.old}" ${changeMark}`);
      }
    }
    console.log('');
  }

  // StarredOos 13件の変化
  console.log('=== StarredOos tier (13件) の変化 ===');
  const starredList = [...plan.values()].filter(p => p.tier === 'starredOos').sort((a, b) => a.id - b.id);
  for (const p of starredList) {
    const arrow = p.new === p.old ? '(変更なし)' : `→ "${p.new}"`;
    console.log(`  id=${String(p.id).padStart(3)} (${p.tokens_old}tok→${p.tokens_new}tok): "${p.old}" ${arrow}`);
  }
  console.log('');

  // 変更サンプル (変化するもの) 30件
  console.log('=== 変更 diff サンプル (変化のあるもの最初30件) ===');
  const sortedChanges = changed.sort((a, b) => a.id - b.id);
  for (const p of sortedChanges.slice(0, 30)) {
    console.log(`  id=${String(p.id).padStart(3)} [${p.tier}] ${p.tokens_old}tok→${p.tokens_new}tok`);
    console.log(`    元: ${p.old}`);
    console.log(`    新: ${p.new}`);
  }
  if (sortedChanges.length > 30) console.log(`  ... 残 ${sortedChanges.length - 30}件`);

  console.log('\n=== サマリ ===');
  console.log(`  DB 書き込みなし (dry-run)`);
  console.log(`  現行 227件 → 衝突 ${collisions.length}グループ (${collisions.reduce((s,[,ids])=>s+ids.length,0)}件影響)`);
  console.log(`  衝突なく短縮できる: ${changed.length - collisions.reduce((s,[,ids])=>s+ids.length,0)}件`);

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
