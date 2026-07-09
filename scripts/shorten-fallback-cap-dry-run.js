#!/usr/bin/env node
// Task 3 案A (選択肢3-b): 容量保持ルール付き段階フォールバック dry-run
//
// アルゴリズム:
//   1. 各 kw の初期 target を計算:
//      - 容量トークン (ml, g, 粒, 回分 等) が含まれる場合、その最終位置 (1-indexed) を初期 target とする
//      - 上記に該当しない場合、初期 target = 2
//      - ただし初期 target が MAX_TOK (=4) を超える場合はそのまま (追加短縮せず変更なし)
//   2. 現状 target で短縮 → 衝突検出 → 衝突する id を +1 → 再検出
//   3. MAX_TOK に達しても衝突が残るものは stuck (原文維持)
//
// DB書込みなし。

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');
const TierClassifier = require('../src/services/TierClassifier');

function tokenize(s) {
  return s.split(/[\s　]+/).filter(Boolean);
}
function truncate(kw, n) {
  return tokenize(kw).slice(0, n).join(' ');
}

// 容量トークン検出パターン (owner 指示: 容量情報を含む場合は 3tok以上を維持)
// 「\d+袋」は容量ではなくセット数量なので除外
// 全角数字 (０-９) も対象 (例: id=179 "５g")
const CAPACITY_PATTERN = /([\d０-９]+(\.[\d０-９]+)?\s*(ml|g|㎖|㎎|ｇ|グラム|kg)|[\d０-９]+粒|[\d０-９]+回分)/i;

// 容量トークンが最初に現れる位置 (1-indexed)、なければ 0 を返す
function capacityTokenPosition(keyword) {
  const tokens = tokenize(keyword);
  for (let i = 0; i < tokens.length; i++) {
    if (CAPACITY_PATTERN.test(tokens[i])) return i + 1;
  }
  return 0;
}

// 情報消失タイプ検出 (前スクリプトと同じ)
const INFO_PATTERNS = {
  '容量': CAPACITY_PATTERN,
  '味/風味': /(味|オレンジ|ブドウ|パイン|マンゴー|ピュアムスク|バーベナ|ホワイトリリー|ユズ|ベルガモット|レモン|カラメル|コーヒー|抹茶|matcha|caramel|latte)/i,
  'サイズ': /(大|小|Sサイズ|Mサイズ|Lサイズ|for Kids|BROSSE)/i,
  'セット数量': /(\d+袋|\d+個セット|\d+袋セット|\d+本)/i,
};

function detectInfoLoss(original, shortForm) {
  const losses = [];
  for (const [type, pattern] of Object.entries(INFO_PATTERNS)) {
    if (pattern.test(original) && !pattern.test(shortForm)) losses.push(type);
  }
  return losses;
}

function detectCollisions(shortByIdMap) {
  const finalMap = new Map();
  for (const [id, shortForm] of shortByIdMap.entries()) {
    if (!finalMap.has(shortForm)) finalMap.set(shortForm, []);
    finalMap.get(shortForm).push(id);
  }
  const collidingIds = new Set();
  const groups = [];
  for (const [key, ids] of finalMap.entries()) {
    if (ids.length > 1) {
      for (const id of ids) collidingIds.add(id);
      groups.push({ key, ids });
    }
  }
  return { collidingIds, groups };
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const all = await Keyword.findAll({
    order: [['id', 'ASC']],
    attributes: ['id', 'keyword', 'crossmallItemCode'],
    raw: true,
  });
  const classes = await TierClassifier.classifyAll();
  const tierOf = new Map();
  for (const t of ['hot', 'warm', 'cold', 'starredOos']) {
    for (const k of (classes[t] || [])) tierOf.set(k.id, t);
  }

  console.log('=== Task 3-b: 容量保持ルール付き段階フォールバック dry-run ===');
  console.log(`  対象: 全 ${all.length}件`);
  console.log(`  ルール: 容量トークン (ml, g, 粒, 回分等) を含む場合、その位置以上を維持`);
  console.log(`  戦略: 初期target=max(2, 容量位置) → 衝突なら +1 → MAX_TOK(4) で stuck\n`);
  console.log(`  Tier: hot=${classes.hot.length} warm=${classes.warm.length} ` +
    `cold=${classes.cold.length} starredOos=${classes.starredOos?.length || 0}\n`);

  const MAX_TOK = 4;

  // 各 kw の初期 target を計算
  const tokTargetById = new Map();
  const capacityStarted = new Set(); // 容量ルールで初期 target が引き上げられた kw
  const capacityOverMaxTok = new Set(); // 選択肢B: 容量位置が MAX_TOK 超え → 原文維持
  for (const kw of all) {
    const capPos = capacityTokenPosition(kw.keyword);
    let initial = Math.max(2, capPos);
    if (capPos > 0 && capPos > 2) capacityStarted.add(kw.id);
    // 選択肢B: 容量トークンが MAX_TOK を超える位置にある場合、短縮を諦めて原文維持
    if (capPos > MAX_TOK) {
      initial = tokenize(kw.keyword).length; // 元 tokens 長 = 変更なし
      capacityOverMaxTok.add(kw.id);
    }
    tokTargetById.set(kw.id, initial);
  }

  console.log(`=== 初期 target 内訳 (容量ルール適用前後) ===`);
  const initByN = {};
  for (const v of tokTargetById.values()) initByN[v] = (initByN[v] || 0) + 1;
  for (const [k, v] of Object.entries(initByN).sort()) {
    console.log(`  target=${k}tok から開始: ${v}件`);
  }
  console.log(`  うち容量ルールで初期target引き上げられた: ${capacityStarted.size}件`);
  console.log(`  うち選択肢B (容量>MAX_TOK) で原文維持となる: ${capacityOverMaxTok.size}件\n`);

  // イテレーション
  let iteration = 0;
  while (true) {
    iteration++;
    const shortByIdMap = new Map();
    for (const kw of all) {
      const target = tokTargetById.get(kw.id);
      shortByIdMap.set(kw.id, truncate(kw.keyword, target));
    }
    const { collidingIds } = detectCollisions(shortByIdMap);
    if (collidingIds.size === 0) {
      console.log(`  ✓ iteration ${iteration}: 衝突なし、収束\n`);
      break;
    }
    let escalated = 0;
    let stuck = 0;
    for (const id of collidingIds) {
      const cur = tokTargetById.get(id);
      if (cur < MAX_TOK) {
        tokTargetById.set(id, cur + 1);
        escalated++;
      } else {
        stuck++;
      }
    }
    console.log(`  iteration ${iteration}: 衝突 ${collidingIds.size}件 → +1 ${escalated}件、上限到達 ${stuck}件`);
    if (escalated === 0) break;
  }

  // 最終計画
  const finalPlan = [];
  for (const kw of all) {
    const target = tokTargetById.get(kw.id);
    const shortForm = truncate(kw.keyword, target);
    const noChange = shortForm === kw.keyword;
    finalPlan.push({
      id: kw.id,
      old: kw.keyword,
      new: shortForm,
      tier: tierOf.get(kw.id) || '?',
      targetTok: target,
      origTokens: tokenize(kw.keyword).length,
      noChange,
      infoLoss: noChange ? [] : detectInfoLoss(kw.keyword, shortForm),
      capacityStarted: capacityStarted.has(kw.id),
    });
  }

  // 最終衝突で stuck を revert
  const finalShortByIdMap = new Map(finalPlan.map(p => [p.id, p.new]));
  const stuckIds = detectCollisions(finalShortByIdMap).collidingIds;
  for (const p of finalPlan) {
    if (stuckIds.has(p.id)) {
      p.new = p.old;
      p.noChange = true;
      p.targetTok = 'stuck';
      p.infoLoss = [];
    }
  }

  // 段階別集計
  const byStage = { '2tok': 0, '3tok': 0, '4tok': 0, 'stuck': 0, 'noChange(元が既に短い)': 0 };
  for (const p of finalPlan) {
    if (stuckIds.has(p.id)) byStage['stuck']++;
    else if (p.noChange) byStage['noChange(元が既に短い)']++;
    else byStage[`${p.targetTok}tok`]++;
  }

  console.log('=== 段階別内訳 ===');
  for (const [k, v] of Object.entries(byStage)) console.log(`  ${k}: ${v}件`);
  console.log('');

  // 容量情報保持の集計
  const withCapacityInOrig = finalPlan.filter(p => CAPACITY_PATTERN.test(p.old));
  const withCapacityInNew  = withCapacityInOrig.filter(p => CAPACITY_PATTERN.test(p.new));
  console.log('=== 容量情報の保持状況 ===');
  console.log(`  元に容量情報を含む kw: ${withCapacityInOrig.length}件`);
  console.log(`  短縮後も容量情報を含む: ${withCapacityInNew.length}件 (保持率 ${Math.round(withCapacityInNew.length/withCapacityInOrig.length*100)}%)`);
  const capacityLost = withCapacityInOrig.filter(p => !CAPACITY_PATTERN.test(p.new));
  if (capacityLost.length > 0) {
    console.log(`  ⚠️ 容量情報が消失した kw: ${capacityLost.length}件`);
    for (const p of capacityLost) {
      console.log(`    id=${String(p.id).padStart(3)} [${p.tier}] "${p.old}"`);
      console.log(`         → "${p.new}" (target=${p.targetTok})`);
    }
  } else {
    console.log(`  ✅ 容量情報消失なし`);
  }
  console.log('');

  // 前回 (無ルール) と Task 3-b (容量ルール付き) の差分
  console.log('=== StarredOos tier 最終状態 (' +
    finalPlan.filter(p => p.tier === 'starredOos').length + '件) ===');
  for (const p of finalPlan.filter(p => p.tier === 'starredOos').sort((a, b) => a.id - b.id)) {
    const arrow = p.noChange ? '(変更なし)' : `→ ${p.targetTok}tok: "${p.new}"`;
    const info = p.infoLoss.length ? ` [消失: ${p.infoLoss.join(',')}]` : '';
    const capMark = p.capacityStarted ? ' 【容量ルール】' : '';
    console.log(`  id=${String(p.id).padStart(3)} (元${p.origTokens}tok): "${p.old}"${capMark}`);
    console.log(`       ${arrow}${info}`);
  }
  console.log('');

  // 情報消失の集計
  const withInfoLoss = finalPlan.filter(p => p.infoLoss.length > 0);
  console.log(`=== 情報消失の集計 (${withInfoLoss.length}件) ===`);
  const lossByType = {};
  for (const p of withInfoLoss) {
    for (const t of p.infoLoss) lossByType[t] = (lossByType[t] || 0) + 1;
  }
  for (const [t, n] of Object.entries(lossByType)) console.log(`  ${t}: ${n}件`);
  console.log('');

  // 各段階のサンプル
  console.log('=== 各段階のサンプル (最大 5件、容量ルール適用kwを優先表示) ===');
  for (const targetTok of [2, 3, 4]) {
    const list = finalPlan.filter(p => !p.noChange && p.targetTok === targetTok);
    const capList = list.filter(p => p.capacityStarted).slice(0, 3);
    const other = list.filter(p => !p.capacityStarted).slice(0, 5 - capList.length);
    const sample = [...capList, ...other];
    console.log(`\n  --- ${targetTok}tok 短縮 (${list.length}件のうちサンプル ${sample.length}件) ---`);
    for (const p of sample) {
      const capMark = p.capacityStarted ? ' [容量ルール]' : '';
      console.log(`    id=${String(p.id).padStart(3)} [${p.tier}]${capMark} "${p.old}"`);
      console.log(`         → "${p.new}"${p.infoLoss.length ? ` (消失: ${p.infoLoss.join(',')})` : ''}`);
    }
  }
  const stuckList = finalPlan.filter(p => stuckIds.has(p.id));
  console.log(`\n  --- 上限到達で「変更なし」 (${stuckList.length}件) ---`);
  for (const p of stuckList) {
    console.log(`    id=${String(p.id).padStart(3)} [${p.tier}] "${p.old}" (原文維持)`);
  }
  console.log('');

  console.log('=== 最終サマリ ===');
  const changed = finalPlan.filter(p => !p.noChange);
  console.log(`  変更対象: ${changed.length}件`);
  console.log(`    2tok: ${byStage['2tok']}件`);
  console.log(`    3tok: ${byStage['3tok']}件`);
  console.log(`    4tok: ${byStage['4tok']}件`);
  console.log(`  stuck (原文維持): ${byStage['stuck']}件`);
  console.log(`  noChange (元が既に短い): ${byStage['noChange(元が既に短い)']}件`);
  console.log(`  容量情報保持率: ${Math.round(withCapacityInNew.length/withCapacityInOrig.length*100)}% (${withCapacityInNew.length}/${withCapacityInOrig.length})`);
  console.log(`  DB書込みなし (dry-run)`);

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
