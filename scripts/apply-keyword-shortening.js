#!/usr/bin/env node
// 新規追加157件 (id>77) のキーワード短縮を実適用する。
//
// Step 1: D 108件 → 先頭3トークンに短縮
// Step 2 (A): 10件 (id=88,126,127,139,140,141,168,174,177,178) → 先頭4トークンに短縮
//              4トークンでも他keywordと衝突する場合は skip & 報告
// Step 2 (B): id=83, 212 は現状維持
//              id=202 は data quality bug、CROSSMALL get_item で正しい商品名を取得し
//              3トークンで短縮 (crossmallItemCode=2314-001935 は維持)
// C 36件は元が既に≤3トークンで現状維持 (更新なし)
//
// 使い方:
//   node scripts/apply-keyword-shortening.js --dry-run   # 変更内容表示のみ、DB書込みなし
//   node scripts/apply-keyword-shortening.js --commit    # 実DB更新
//
// 事前実行: DB バックアップを取ってから --commit で適用すること

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword } = require('../src/models');
const CrossmallService = require('../src/services/CrossmallService');

const IS_COMMIT = process.argv.includes('--commit');
const IS_DRY = !IS_COMMIT;

// A: 4トークンで再短縮する id
const A_IDS = [88, 126, 127, 139, 140, 141, 168, 174, 177, 178];
// B: 個別対応
const B_KEEP_AS_IS = [83, 212];
const B_FETCH_AND_SHORTEN = 202;

const KEEP_TOKENS_D = 3;
const KEEP_TOKENS_A = 4;
const KEEP_TOKENS_B202 = 3;

function tokenize(s) {
  return s.split(/[\s　]+/).filter(Boolean);
}
function shorten(kw, n) {
  return tokenize(kw).slice(0, n).join(' ');
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const all = await Keyword.findAll({ order: [['id', 'ASC']], attributes: ['id', 'keyword', 'crossmallItemCode'], raw: true });
  const seeds = all.filter(k => k.id <= 77);
  const news = all.filter(k => k.id > 77);

  console.log(`=== apply-keyword-shortening ${IS_COMMIT ? '★ COMMIT ★' : 'dry-run'} ===`);
  console.log(`  seed (id<=77): ${seeds.length}件 / 新規 (id>77): ${news.length}件`);

  // 各 kw の新 keyword 候補を計算
  const plan = new Map(); // id -> { old, new, category }
  for (const kw of all) {
    plan.set(kw.id, { id: kw.id, old: kw.keyword, new: kw.keyword, category: '(unchanged)' });
  }

  // Step 1: D 108件 (id>77 かつ A/B に該当しない かつ 元が >3 tokens)
  for (const kw of news) {
    if (A_IDS.includes(kw.id)) continue;
    if (B_KEEP_AS_IS.includes(kw.id)) continue;
    if (kw.id === B_FETCH_AND_SHORTEN) continue;
    const tokens = tokenize(kw.keyword);
    if (tokens.length <= KEEP_TOKENS_D) continue; // C: 短縮不要
    const shortForm = shorten(kw.keyword, KEEP_TOKENS_D);
    plan.get(kw.id).new = shortForm;
    plan.get(kw.id).category = 'D:3tok短縮';
  }

  // Step 2 (A): 10件を 4 tokens で短縮
  for (const id of A_IDS) {
    const kw = news.find(k => k.id === id);
    if (!kw) continue;
    const tokens = tokenize(kw.keyword);
    if (tokens.length <= KEEP_TOKENS_A) {
      plan.get(id).category = 'A:元4tok以下、変更なし';
      continue;
    }
    plan.get(id).new = shorten(kw.keyword, KEEP_TOKENS_A);
    plan.get(id).category = 'A:4tok短縮';
  }

  // Step 2 (B): id=202 は CROSSMALL からベース商品名取得
  const kw202 = news.find(k => k.id === B_FETCH_AND_SHORTEN);
  if (kw202) {
    console.log(`\n[B] id=202 の CROSSMALL 商品名を get_item で取得中...`);
    const svc = new CrossmallService();
    const code = kw202.crossmallItemCode || '2314-001935';
    const info = await svc.getItemInfo([code]);
    const fullName = info[code]?.name;
    if (fullName) {
      const shortForm = shorten(fullName, KEEP_TOKENS_B202);
      plan.get(202).new = shortForm;
      plan.get(202).category = `B:CROSSMALL名から3tok短縮 (fullName="${fullName}")`;
      console.log(`  取得成功: "${fullName}"`);
      console.log(`  短縮後: "${shortForm}"`);
    } else {
      console.warn(`  ⚠️ get_item で商品名取得失敗 (code=${code})、id=202 は変更しない`);
      plan.get(202).category = 'B:get_item失敗、変更なし';
    }
  }

  // 衝突チェック: 新 keyword 文字列で全体重複を検査
  const finalMap = new Map(); // final keyword → [ids...]
  for (const [id, p] of plan.entries()) {
    const key = p.new;
    if (!finalMap.has(key)) finalMap.set(key, []);
    finalMap.get(key).push(id);
  }
  const collisions = [...finalMap.entries()].filter(([, ids]) => ids.length > 1);

  console.log('\n=== 適用計画 ===');
  const changed = [...plan.values()].filter(p => p.new !== p.old);
  console.log(`  変更対象: ${changed.length}件`);
  const byCategory = {};
  for (const p of changed) byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  for (const [c, n] of Object.entries(byCategory)) console.log(`    ${c}: ${n}件`);

  // 変更 diff サンプル出力
  console.log('\n=== 変更 diff サンプル (最初20件) ===');
  const sortedChanges = changed.sort((a, b) => a.id - b.id);
  for (const p of sortedChanges.slice(0, 20)) {
    console.log(`  id=${String(p.id).padStart(3)} [${p.category}]`);
    console.log(`    元: ${p.old}`);
    console.log(`    新: ${p.new}`);
  }
  if (sortedChanges.length > 20) console.log(`  ... 残 ${sortedChanges.length - 20}件`);

  if (collisions.length > 0) {
    console.log('\n⚠️ === 衝突検出 (適用後に同一キーワードになる ID 群) ===');
    for (const [key, ids] of collisions) {
      console.log(`  "${key}" → ids=[${ids.join(', ')}]`);
      for (const id of ids) {
        const p = plan.get(id);
        console.log(`    id=${id} [${p.category}] 元="${p.old}"`);
      }
    }
    console.log(`\n合計衝突: ${collisions.length}グループ、DB更新は中止します`);
    if (IS_COMMIT) {
      console.error('★ COMMIT モードで衝突検出、適用せず終了');
      await sequelize.close();
      process.exit(1);
    }
  } else {
    console.log('\n✅ 衝突なし、適用可能');
  }

  if (IS_COMMIT && collisions.length === 0) {
    console.log('\n=== ★ DB 更新 ★ ===');
    let updateCount = 0;
    for (const p of changed) {
      const kw = await Keyword.findByPk(p.id);
      if (!kw) continue;
      await kw.update({ keyword: p.new });
      updateCount++;
    }
    console.log(`  ${updateCount}件更新完了`);
    // 検証
    const total = await Keyword.count();
    console.log(`  Keyword 総数 (変更なし想定): ${total}`);
  } else {
    console.log('\n=== dry-run: DB 更新なし ===');
    console.log('  --commit で実行してください');
  }

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
