#!/usr/bin/env node
// Win 版比較で判明した 3 つのギャップに対する個別修正を DB に適用する。
//
// 変更内容:
//   1. id=38「セノッピー」の excludeKeywords に "CHEWABLE" を追加
//      (現状 "チュアブル" のみ → "チュアブル,CHEWABLE")
//   2. id=53「エティアキシル」の crossmallItemCode を null → "2314-0001163" に設定
//   3. id=49「ラブリービー」の notified=0 かつ 2026-07-01 由来の
//      DetectedItem レコードを削除 (想定 45件)
//   4. id=72「バルクス レッドギア」の notified=0 かつ 2026-07-01 由来の
//      DetectedItem レコードを削除 (想定 49件)
//
// 目的:
//   1,2 は kw 設定の直接改善。3,4 は「NOTIFY_CAP_PER_SCAN 超過による
//   notified=false 永続化」で埋もれたレコードを個別削除することにより、
//   次回スキャンで再検知 → 正常通知への復旧を狙う。
//
// 使い方:
//   node scripts/apply-win-gap-corrections.js            # dry-run (書込みなし)
//   node scripts/apply-win-gap-corrections.js --commit   # 実 DB 更新
//
// 事前: DB バックアップ必須。

'use strict';

require('dotenv').config();
const { sequelize, Keyword, DetectedItem } = require('../src/models');
const { Op } = require('sequelize');

const IS_COMMIT = process.argv.includes('--commit');

// 07-01 バーストの範囲。JST 19:39頃 = UTC 10:39
// 該当 kw の初期検知は 2026-07-01 10:39〜12:42 UTC の一気読みバースト
const BURST_START = '2026-07-01 00:00:00';
const BURST_END   = '2026-07-01 23:59:59';

const EXPECTED_ID49_DELETE = 45;
const EXPECTED_ID72_DELETE = 49;

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  console.log(`=== apply-win-gap-corrections ${IS_COMMIT ? '★ COMMIT ★' : 'dry-run'} ===\n`);

  // ------------------------------------------------------------
  // 1. id=38 excludeKeywords 更新
  // ------------------------------------------------------------
  const kw38 = await Keyword.findByPk(38, { raw: true });
  console.log('[1] id=38「セノッピー」excludeKeywords');
  if (!kw38) { console.error('  ERROR: id=38 が見つかりません'); process.exit(1); }
  console.log(`  before: "${kw38.excludeKeywords}"`);
  const oldEx = (kw38.excludeKeywords || '').split(',').map(s => s.trim()).filter(Boolean);
  if (oldEx.includes('CHEWABLE')) {
    console.log('  → 既に CHEWABLE を含む、スキップ');
  } else {
    const newEx = [...oldEx, 'CHEWABLE'].join(',');
    console.log(`  after : "${newEx}"`);
    if (IS_COMMIT) {
      await Keyword.update({ excludeKeywords: newEx }, { where: { id: 38 } });
      console.log('  ✓ 更新完了');
    }
  }

  // ------------------------------------------------------------
  // 2. id=53 crossmallItemCode 設定
  // ------------------------------------------------------------
  const kw53 = await Keyword.findByPk(53, { raw: true });
  console.log('\n[2] id=53「エティアキシル」crossmallItemCode');
  if (!kw53) { console.error('  ERROR: id=53 が見つかりません'); process.exit(1); }
  console.log(`  before: ${kw53.crossmallItemCode ?? 'null'}`);
  const NEW_CODE = '2314-0001163';
  if (kw53.crossmallItemCode === NEW_CODE) {
    console.log('  → 既に設定済み、スキップ');
  } else if (kw53.crossmallItemCode && kw53.crossmallItemCode !== NEW_CODE) {
    console.error(`  ⚠️ 想定と異なる既存値 (${kw53.crossmallItemCode})、中断`);
    process.exit(2);
  } else {
    console.log(`  after : "${NEW_CODE}"`);
    if (IS_COMMIT) {
      await Keyword.update({ crossmallItemCode: NEW_CODE }, { where: { id: 53 } });
      console.log('  ✓ 更新完了');
    }
  }

  // ------------------------------------------------------------
  // 3. id=49 DetectedItem 削除 (notified=0 かつ 07-01 由来)
  // ------------------------------------------------------------
  console.log('\n[3] id=49「ラブリービー」DetectedItem 削除 (notified=0, 07-01 由来)');
  const target49 = await DetectedItem.findAll({
    where: {
      keywordId: 49,
      notified: false,
      createdAt: { [Op.gte]: BURST_START, [Op.lte]: BURST_END },
    },
    raw: true,
  });
  console.log(`  対象件数: ${target49.length} (想定: ${EXPECTED_ID49_DELETE})`);
  console.log(`  createdAt 範囲: ${target49[0]?.createdAt ?? '(0件)'} 〜 ${target49[target49.length - 1]?.createdAt ?? '(0件)'}`);
  if (target49.length !== EXPECTED_ID49_DELETE) {
    console.error(`  ⚠️ 想定件数 ${EXPECTED_ID49_DELETE} と実測 ${target49.length} が異なります`);
    if (IS_COMMIT) { console.error('  中断します'); process.exit(3); }
  } else {
    console.log('  ✓ 想定件数と一致');
  }
  if (IS_COMMIT) {
    const n = await DetectedItem.destroy({
      where: {
        keywordId: 49,
        notified: false,
        createdAt: { [Op.gte]: BURST_START, [Op.lte]: BURST_END },
      },
    });
    console.log(`  ✓ ${n} 件削除`);
  }

  // ------------------------------------------------------------
  // 4. id=72 DetectedItem 削除
  // ------------------------------------------------------------
  console.log('\n[4] id=72「バルクス レッドギア」DetectedItem 削除 (notified=0, 07-01 由来)');
  const target72 = await DetectedItem.findAll({
    where: {
      keywordId: 72,
      notified: false,
      createdAt: { [Op.gte]: BURST_START, [Op.lte]: BURST_END },
    },
    raw: true,
  });
  console.log(`  対象件数: ${target72.length} (想定: ${EXPECTED_ID72_DELETE})`);
  console.log(`  createdAt 範囲: ${target72[0]?.createdAt ?? '(0件)'} 〜 ${target72[target72.length - 1]?.createdAt ?? '(0件)'}`);
  if (target72.length !== EXPECTED_ID72_DELETE) {
    console.error(`  ⚠️ 想定件数 ${EXPECTED_ID72_DELETE} と実測 ${target72.length} が異なります`);
    if (IS_COMMIT) { console.error('  中断します'); process.exit(4); }
  } else {
    console.log('  ✓ 想定件数と一致');
  }
  if (IS_COMMIT) {
    const n = await DetectedItem.destroy({
      where: {
        keywordId: 72,
        notified: false,
        createdAt: { [Op.gte]: BURST_START, [Op.lte]: BURST_END },
      },
    });
    console.log(`  ✓ ${n} 件削除`);
  }

  // ------------------------------------------------------------
  // 事後検証
  // ------------------------------------------------------------
  console.log('\n=== 事後検証 ===');
  if (IS_COMMIT) {
    const a38 = await Keyword.findByPk(38, { raw: true });
    console.log(`  id=38 excludeKeywords: "${a38.excludeKeywords}"`);
    const a53 = await Keyword.findByPk(53, { raw: true });
    console.log(`  id=53 crossmallItemCode: ${a53.crossmallItemCode}`);
    const [rem49] = await sequelize.query("SELECT COUNT(*) AS c FROM DetectedItems WHERE keywordId=49");
    const [rem72] = await sequelize.query("SELECT COUNT(*) AS c FROM DetectedItems WHERE keywordId=72");
    console.log(`  id=49 残 DetectedItem: ${rem49[0].c} (通知済み分のみ残っているはず)`);
    console.log(`  id=72 残 DetectedItem: ${rem72[0].c}`);
  } else {
    console.log('  (dry-run のため事後検証はスキップ)');
  }

  await sequelize.close();
  console.log(IS_COMMIT ? '\n★ COMMIT 完了' : '\n[dry-run] --commit を付けて再実行してください');
}

main().catch(e => { console.error(e); process.exit(1); });
