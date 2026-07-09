#!/usr/bin/env node
// Task 3-b 選択肢A: 容量保持ルール付き段階フォールバック keyword 短縮の実適用
//
// アルゴリズム: shorten-fallback-cap-dry-run.js と同一
//   1. 各 kw の初期 target を計算:
//      - 容量トークン (ml, g, 粒, 回分等、全角数字対応) の位置を検出
//      - 初期 target = max(2, 容量位置)
//      - 容量位置 > MAX_TOK(4) の場合、原文維持 (選択肢B ガード)
//   2. 衝突検出 → 衝突する id を +1 で 3tok/4tok に格上げ
//   3. MAX_TOK に達しても衝突が残るものは原文維持 (stuck)
//
// 使い方:
//   node scripts/apply-keyword-shortening-fallback-capacity.js            # dry-run (書込みなし)
//   node scripts/apply-keyword-shortening-fallback-capacity.js --commit   # 実DB更新
//
// 事前: DB バックアップ必須

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');
const TierClassifier = require('../src/services/TierClassifier');

const IS_COMMIT = process.argv.includes('--commit');
const MAX_TOK = 4;

// 「\d+袋」はセット数量、容量ではないので除外
// 全角数字 (０-９) にも対応 (例: id=179 "５g")
const CAPACITY_PATTERN = /([\d０-９]+(\.[\d０-９]+)?\s*(ml|g|㎖|㎎|ｇ|グラム|kg)|[\d０-９]+粒|[\d０-９]+回分)/i;

function tokenize(s) { return s.split(/[\s　]+/).filter(Boolean); }
function truncate(kw, n) { return tokenize(kw).slice(0, n).join(' '); }

function capacityTokenPosition(keyword) {
  const tokens = tokenize(keyword);
  for (let i = 0; i < tokens.length; i++) {
    if (CAPACITY_PATTERN.test(tokens[i])) return i + 1;
  }
  return 0;
}

function detectCollisions(shortByIdMap) {
  const finalMap = new Map();
  for (const [id, shortForm] of shortByIdMap.entries()) {
    if (!finalMap.has(shortForm)) finalMap.set(shortForm, []);
    finalMap.get(shortForm).push(id);
  }
  const collidingIds = new Set();
  for (const [, ids] of finalMap.entries()) {
    if (ids.length > 1) for (const id of ids) collidingIds.add(id);
  }
  return { collidingIds };
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const all = await Keyword.findAll({
    order: [['id', 'ASC']],
    attributes: ['id', 'keyword', 'crossmallItemCode'],
    raw: true,
  });

  console.log(`=== apply-keyword-shortening-fallback-capacity ${IS_COMMIT ? '★ COMMIT ★' : 'dry-run'} ===`);
  console.log(`  対象: 全 ${all.length}件`);

  // 初期 target 計算 (容量ルール + 選択肢B ガード)
  const tokTargetById = new Map();
  for (const kw of all) {
    const capPos = capacityTokenPosition(kw.keyword);
    let initial = Math.max(2, capPos);
    if (capPos > MAX_TOK) initial = tokenize(kw.keyword).length; // 原文維持
    tokTargetById.set(kw.id, initial);
  }

  // 衝突フォールバック
  let iteration = 0;
  while (true) {
    iteration++;
    const shortByIdMap = new Map();
    for (const kw of all) {
      shortByIdMap.set(kw.id, truncate(kw.keyword, tokTargetById.get(kw.id)));
    }
    const { collidingIds } = detectCollisions(shortByIdMap);
    if (collidingIds.size === 0) {
      console.log(`  ✓ iteration ${iteration}: 衝突なし、収束`);
      break;
    }
    let escalated = 0;
    for (const id of collidingIds) {
      const cur = tokTargetById.get(id);
      if (cur < MAX_TOK) {
        tokTargetById.set(id, cur + 1);
        escalated++;
      }
    }
    console.log(`  iteration ${iteration}: 衝突 ${collidingIds.size}件、+1 ${escalated}件`);
    if (escalated === 0) break;
  }

  // 最終 plan (stuck は原文維持)
  const finalPlan = [];
  const finalShortByIdMap = new Map();
  for (const kw of all) {
    const target = tokTargetById.get(kw.id);
    finalShortByIdMap.set(kw.id, truncate(kw.keyword, target));
  }
  const stuckIds = detectCollisions(finalShortByIdMap).collidingIds;
  for (const kw of all) {
    const target = tokTargetById.get(kw.id);
    let shortForm = truncate(kw.keyword, target);
    if (stuckIds.has(kw.id)) shortForm = kw.keyword; // 原文維持
    finalPlan.push({
      id: kw.id,
      old: kw.keyword,
      new: shortForm,
      noChange: shortForm === kw.keyword,
    });
  }

  const changed = finalPlan.filter(p => !p.noChange);
  console.log(`\n=== 変更計画 ===`);
  console.log(`  変更対象: ${changed.length}件`);
  console.log(`  変更なし: ${finalPlan.length - changed.length}件`);

  console.log(`\n=== 変更 diff (先頭20件) ===`);
  for (const p of changed.slice(0, 20)) {
    console.log(`  id=${String(p.id).padStart(3)}`);
    console.log(`    元: ${p.old}`);
    console.log(`    新: ${p.new}`);
  }
  if (changed.length > 20) console.log(`  ...残 ${changed.length - 20}件`);

  if (IS_COMMIT) {
    console.log(`\n=== ★ DB 更新 ★ ===`);
    let count = 0;
    for (const p of changed) {
      const kw = await Keyword.findByPk(p.id);
      if (!kw) continue;
      await kw.update({ keyword: p.new });
      count++;
    }
    console.log(`  ${count}件更新完了`);
    const total = await Keyword.count();
    console.log(`  Keyword 総数 (変更なし想定): ${total}`);
  } else {
    console.log(`\n=== dry-run: DB 更新なし ===`);
    console.log(`  --commit で実適用してください`);
  }

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
