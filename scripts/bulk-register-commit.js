#!/usr/bin/env node
// Task② 実登録スクリプト: nコード名寄せ + フィルタ + Keyword 一括登録
//
// 事前条件:
//   - .env で TELEGRAM_NOTIFY_ENABLED=false に変更済み (慣らし運転手順の一部)
//   - PM2 再起動 --update-env 済み
//   - DB バックアップ済み
//
// 使い方:
//   node scripts/bulk-register-commit.js --dry-run    # 名寄せ結果と最終件数のみ表示
//   node scripts/bulk-register-commit.js --commit     # 実際に Keyword を bulkCreate
//
// 処理概要:
//   1. CrossmallProduct.baseItemCode カラムを alter で追加 (初回のみ)
//   2. 2314- prefix の全 CrossmallProduct について baseItemCode を計算・保存
//      - 末尾 "n" を除いた base が CrossmallProduct に存在すれば n派生 → baseItemCode = base
//      - それ以外は baseItemCode = itemCode (自身がベース)
//      - 末尾 "n" だが base が存在しない → orphan として除外・報告
//   3. ベース単位で集約 (メンバー = base + n派生)
//      - passes filter: 任意メンバーの sales28>0 OR stock>0
//   4. 既存 Keyword.crossmallItemCode に登録済のベースはスキップ
//   5. 未マップのベースについて get_item でベース名を取得
//   6. Keyword.bulkCreate (platforms=['mercari'])
//   7. 例外一覧を最後に出力

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword, CrossmallProduct, initDB } = require('../src/models');
const CrossmallService = require('../src/services/CrossmallService');

const args = new Set(process.argv.slice(2));
const IS_COMMIT = args.has('--commit');
const IS_DRY = args.has('--dry-run') || !IS_COMMIT;

function log(...a) { console.log(...a); }
function warn(...a) { console.warn(...a); }

function stripNSuffix(itemCode) {
  return itemCode.endsWith('n') ? itemCode.slice(0, -1) : itemCode;
}

function endsWithLetter(itemCode) {
  return /[A-Za-z]$/.test(itemCode);
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  log(`=== Task② Commit: ${IS_COMMIT ? '★ COMMIT モード (実DB書込) ★' : 'dry-run モード'} ===\n`);

  // Step 1: schema migration (baseItemCode カラム追加)
  log('[1] CrossmallProduct.baseItemCode カラム確保 (alter sync)...');
  await CrossmallProduct.sync({ alter: true });

  // Step 2: 全 2314- 製品を取得し、baseItemCode を判定
  log('[2] 2314- 商品の baseItemCode 判定...');
  const all2314 = await CrossmallProduct.findAll({
    where: { itemCode: { [Op.like]: '2314-%' } },
    raw: true,
  });
  log(`    対象: ${all2314.length}件`);

  const codeSet = new Set(all2314.map(p => p.itemCode));

  // 各種カテゴリ集計
  const bases = new Set();                 // 「自身がベース」と判定した itemCode
  const nVariants = [];                    // n派生: { code, base }
  const orphanNs = [];                     // 末尾 n だが base 不在
  const unusualLetterEnd = [];             // 末尾が n 以外の英字 (要注意)

  for (const p of all2314) {
    const code = p.itemCode;
    if (code.endsWith('n')) {
      const base = stripNSuffix(code);
      if (codeSet.has(base)) {
        nVariants.push({ code, base });
      } else {
        orphanNs.push({ code, sales28: p.sales28 || 0, stock: p.stock || 0, itemName: p.itemName || '' });
      }
    } else {
      bases.add(code);
      if (endsWithLetter(code)) {
        unusualLetterEnd.push({ code, sales28: p.sales28 || 0, stock: p.stock || 0, itemName: p.itemName || '' });
      }
    }
  }

  log(`    ベースコード: ${bases.size}件`);
  log(`    n派生 (baseあり): ${nVariants.length}件 → ベースに名寄せ`);
  log(`    orphan n (base不在): ${orphanNs.length}件 → 除外・例外一覧に記録`);
  log(`    末尾n以外の英字 (要注意): ${unusualLetterEnd.length}件`);

  // Step 3: baseItemCode を CrossmallProduct に書き込み (dry-run でも実行、キャッシュ性)
  //         これはメタデータの正規化であり Keyword 書込ではない
  log('[3] baseItemCode 永続化...');
  {
    const codeToBase = new Map();
    for (const code of bases) codeToBase.set(code, code);
    for (const { code, base } of nVariants) codeToBase.set(code, base);
    // orphan はそのまま (base = null 保持)
    for (const [code, base] of codeToBase.entries()) {
      await CrossmallProduct.update({ baseItemCode: base }, { where: { itemCode: code } });
    }
    log(`    ${codeToBase.size}件に baseItemCode を書込`);
  }

  // Step 4: ベース単位で集約
  log('[4] ベース単位で集約...');
  const perBase = new Map(); // base -> { members: [products], combSales, combStock }
  for (const p of all2314) {
    const code = p.itemCode;
    let base;
    if (code.endsWith('n')) {
      const b = stripNSuffix(code);
      if (codeSet.has(b)) base = b;
      else continue; // orphan は集約対象外
    } else {
      base = code;
    }
    if (!perBase.has(base)) perBase.set(base, { members: [], combSales: 0, combStock: 0 });
    const entry = perBase.get(base);
    entry.members.push(p);
    entry.combSales += p.sales28 || 0;
    entry.combStock += p.stock || 0;
  }
  log(`    ベース総数: ${perBase.size}件 (集約後)`);

  // Step 5: 既存マッピングを除外
  log('[5] 既存 Keyword.crossmallItemCode を除外...');
  const mapped = new Set(
    (await Keyword.findAll({
      attributes: ['crossmallItemCode'],
      where: { crossmallItemCode: { [Op.not]: null } },
      raw: true,
    })).map(r => r.crossmallItemCode).filter(Boolean)
  );
  log(`    既存マップ済ベース: ${mapped.size}件`);

  // Step 6: フィルタ通過ベースの絞込
  const passingBases = [];
  for (const [base, entry] of perBase.entries()) {
    if (mapped.has(base)) continue;
    if (entry.combSales > 0 || entry.combStock > 0) {
      passingBases.push({ base, ...entry });
    }
  }
  log(`    未マップ且つフィルタ通過: ${passingBases.length}件 (=登録予定件数)`);

  // Step 7: ベース側の itemName 保有状況
  const needName = passingBases.filter(b => {
    const baseRow = b.members.find(m => m.itemCode === b.base);
    return !baseRow || !baseRow.itemName || baseRow.itemName.trim() === '';
  });
  log(`    ベース側 itemName 未取得: ${needName.length}件 → get_item で取得`);

  // Step 8: get_item 呼び出しでベース名を取得 (dry-run でも実施、DBに upsert)
  if (needName.length > 0) {
    log(`[6] get_item でベース名を取得中 (${needName.length}件、約 ${Math.ceil(needName.length * 0.25)}秒)...`);
    const svc = new CrossmallService();
    const codes = needName.map(b => b.base);
    const info = await svc.getItemInfo(codes);
    let fetched = 0;
    for (const b of needName) {
      const i = info[b.base];
      if (i && i.name) {
        await CrossmallProduct.upsert({
          itemCode: b.base,
          itemName: i.name,
          purchasePrice: i.purchasePrice || 0,
          retailPrice: i.retailPrice || 0,
          baseItemCode: b.base,
        });
        // memory 更新
        const baseRow = b.members.find(m => m.itemCode === b.base);
        if (baseRow) baseRow.itemName = i.name;
        else b.members.push({ itemCode: b.base, itemName: i.name, sales28: 0, stock: 0 });
        fetched++;
      }
    }
    log(`    itemName 取得成功: ${fetched}/${needName.length}件`);
  }

  // Step 9: 最終登録対象を確定 (itemName 必須)
  const finalCandidates = [];
  const noNameBases = [];
  for (const b of passingBases) {
    const baseRow = b.members.find(m => m.itemCode === b.base) || {};
    const name = (baseRow.itemName || '').trim();
    if (name) finalCandidates.push({ base: b.base, name, sales: b.combSales, stock: b.combStock, members: b.members });
    else noNameBases.push({ base: b.base, sales: b.combSales, stock: b.combStock });
  }
  log(`\n[7] 登録可能: ${finalCandidates.length}件 / itemName 未取得で登録不可: ${noNameBases.length}件`);

  // Step 10: サンプル10件表示
  finalCandidates.sort((a, b) => a.base.localeCompare(b.base));
  log(`\n[8] 登録予定サンプル (先頭 itemCode 昇順 10件):`);
  for (const c of finalCandidates.slice(0, 10)) {
    const variants = c.members.filter(m => m.itemCode !== c.base).map(m => m.itemCode).join(',') || '(n派生なし)';
    log(`    ${c.base}  sales28=${c.sales} stock=${c.stock} name="${c.name}"`);
    if (variants !== '(n派生なし)') log(`      └ n派生: ${variants}`);
  }

  // Step 11: 例外一覧
  log(`\n[9] 例外一覧:`);
  log(`    (a) orphan n派生 (baseがCROSSMALL上に存在しない): ${orphanNs.length}件`);
  for (const o of orphanNs.slice(0, 10)) {
    log(`        ${o.code}  sales28=${o.sales28} stock=${o.stock} name="${o.itemName}"`);
  }
  if (orphanNs.length > 10) log(`        ... 残 ${orphanNs.length - 10}件省略`);

  log(`    (b) 末尾 n 以外の英字を持つ itemCode: ${unusualLetterEnd.length}件`);
  for (const u of unusualLetterEnd.slice(0, 10)) {
    log(`        ${u.code}  sales28=${u.sales28} stock=${u.stock} name="${u.itemName}"`);
  }
  if (unusualLetterEnd.length > 10) log(`        ... 残 ${unusualLetterEnd.length - 10}件省略`);

  log(`    (c) itemName 取得失敗で登録不可: ${noNameBases.length}件`);
  for (const n of noNameBases.slice(0, 10)) {
    log(`        ${n.base}  sales28=${n.sales} stock=${n.stock}`);
  }

  // Step 12: 登録実行 (COMMIT モードのみ)
  if (IS_COMMIT) {
    log(`\n[10] ★ 登録実行 (${finalCandidates.length}件) ★`);
    const beforeCount = await Keyword.count();
    const beforeNames = new Set((await Keyword.findAll({ attributes: ['keyword'], raw: true })).map(r => r.keyword));
    let created = 0, dupSkipped = 0;
    for (const c of finalCandidates) {
      if (beforeNames.has(c.name)) { dupSkipped++; continue; }
      await Keyword.create({
        keyword: c.name,
        platforms: ['mercari'],
        crossmallItemCode: c.base,
        excludeKeywords: '',
        isActive: true,
        minPrice: 0,
        maxPrice: 999999,
        globalExcludeEnabled: true,
      });
      beforeNames.add(c.name);
      created++;
    }
    const afterCount = await Keyword.count();
    log(`    Keyword 総数: ${beforeCount} → ${afterCount} (+${afterCount - beforeCount})`);
    log(`    新規作成: ${created}件 / 重複名スキップ: ${dupSkipped}件`);
  } else {
    log(`\n[10] dry-run: Keyword 書込みなし`);
  }

  // Step 13: サマリ
  log(`\n=== 最終サマリ ===`);
  log(`  2314- 商品総数:                  ${all2314.length}`);
  log(`  ベースコード:                    ${bases.size}`);
  log(`  n派生 (base有り, 名寄せ対象):    ${nVariants.length}`);
  log(`  orphan n (除外):                 ${orphanNs.length}`);
  log(`  末尾n以外の英字 (要注意):        ${unusualLetterEnd.length}`);
  log(`  ベース集約後件数:                ${perBase.size}`);
  log(`  既存マッピング:                  ${mapped.size}`);
  log(`  フィルタ通過ベース:              ${passingBases.length}`);
  log(`  itemName 取得成功で登録可能:     ${finalCandidates.length}`);
  log(`  itemName 未取得で登録不可:       ${noNameBases.length}`);
  if (IS_COMMIT) log(`  ★ 実登録完了 ★`);
  else log(`  → --commit で実登録を実行`);

  await sequelize.close();
}

main().catch(err => {
  console.error('[commit] fatal:', err);
  process.exit(1);
});
