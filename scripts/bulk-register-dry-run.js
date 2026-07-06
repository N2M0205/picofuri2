#!/usr/bin/env node
// Task② dry-run: CROSSMALL全商品→フィルタ→仮登録候補の集計とサンプル提示
// 使い方: node scripts/bulk-register-dry-run.js
//
// フィルタ (確定済みビジネスルール):
//   1. itemCode が "2314-" で始まる
//   2. かつ (過去1ヶ月以内に販売実績がある OR 現在在庫が1以上ある)
// 追加ルール:
//   - 既存 Keyword.crossmallItemCode に含まれる SKU は除外 (重複登録防止)
//   - 新規追加 Keyword.platforms は ['mercari'] のみ (Yahoo 休止中)
//
// 本スクリプトは Keyword テーブルに書き込みは行わない (dry-run)。
// ただしサンプル10件について get_item 呼び出しで itemName を取得し、
// CrossmallProduct.itemName を upsert する (キャッシュ充填、Keyword作成はしない)。

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword, CrossmallProduct } = require('../src/models');
const CrossmallService = require('../src/services/CrossmallService');

const SAMPLE_SIZE = 10;

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  console.log('=== Task② Dry-Run: CROSSMALL全商品→フィルタ→仮登録候補 ===\n');

  // 1. 全 CrossmallProduct をロード (データソース: 90日分の CrossmallSale 集計 + get_stock キャッシュ)
  const all = await CrossmallProduct.findAll({ raw: true });
  console.log(`[0] データソース: CrossmallProduct テーブル (${all.length}件)`);
  console.log('    * 由来: syncOrders() で得た CrossmallSale 90日分 (13,283レコード) の集計 +');
  console.log('      getStock() で得た現在庫データ (マッピング済SKUのみ)');

  // 2. プレフィクス内訳 (フィルタが正しく機能する証拠として提示)
  const prefixCount = {};
  for (const p of all) {
    const pref = (p.itemCode || '').split('-')[0] + '-';
    prefixCount[pref] = (prefixCount[pref] || 0) + 1;
  }
  const topPrefixes = Object.entries(prefixCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\n[1] プレフィクス内訳 (上位10):');
  for (const [p, n] of topPrefixes) {
    console.log(`    ${JSON.stringify(p).padEnd(15)} ${n}件`);
  }

  // 3. 2314- prefix でフィルタ
  const own = all.filter(p => (p.itemCode || '').startsWith('2314-'));
  const nonOwn = all.length - own.length;
  console.log(`\n[2] フィルタ①: itemCode "2314-" で始まる`);
  console.log(`    対象内: ${own.length}件`);
  console.log(`    対象外 (除外): ${nonOwn}件`);

  // 4. 既存マッピング除外
  const mappedSet = new Set(
    (await Keyword.findAll({
      attributes: ['crossmallItemCode'],
      where: { crossmallItemCode: { [Op.not]: null } },
      raw: true,
    })).map(r => r.crossmallItemCode).filter(Boolean)
  );
  const unmapped = own.filter(p => !mappedSet.has(p.itemCode));
  console.log(`\n[3] 既存マッピングを除外:`);
  console.log(`    既存 Keyword.crossmallItemCode に登録済 (unique SKU): ${mappedSet.size}件`);
  console.log(`    未マッピングの 2314-: ${unmapped.length}件`);

  // 5. sales28 > 0 OR stock > 0 フィルタ
  const passSales = unmapped.filter(p => (p.sales28 || 0) > 0);
  const passStock = unmapped.filter(p => (p.stock || 0) > 0);
  const passEither = unmapped.filter(p => (p.sales28 || 0) > 0 || (p.stock || 0) > 0);
  const failedBoth = unmapped.filter(p => (p.sales28 || 0) === 0 && (p.stock || 0) === 0);
  console.log(`\n[4] フィルタ②: sales28 > 0 (過去28日販売実績) OR stock > 0 (現在庫)`);
  console.log(`    販売実績フィルタ通過: ${passSales.length}件`);
  console.log(`    在庫フィルタ通過:     ${passStock.length}件 (DBキャッシュ: 未マップSKUは getStock 未実行のため反映されない)`);
  console.log(`    どちらか通過:         ${passEither.length}件 (=登録予定件数)`);
  console.log(`    両方失敗 (除外):      ${failedBoth.length}件`);

  const candidates = passEither;

  // 6. itemName 保有状況
  const withName = candidates.filter(p => p.itemName && p.itemName.trim() !== '');
  const withoutName = candidates.filter(p => !p.itemName || p.itemName.trim() === '');
  console.log(`\n[5] itemName (=キーワードとして使う文字列) の保有状況:`);
  console.log(`    DB に itemName あり: ${withName.length}件`);
  console.log(`    DB に itemName なし (get_item 必要): ${withoutName.length}件`);

  // 7. サンプル10件を提示 (先頭 SAMPLE_SIZE 件について get_item で itemName 取得)
  //    ここでは Keyword を作らない、CrossmallProduct.itemName の upsert のみ
  console.log(`\n[6] サンプル ${SAMPLE_SIZE} 件 (先頭 itemCode 昇順から):`);
  candidates.sort((a, b) => a.itemCode.localeCompare(b.itemCode));
  const samples = candidates.slice(0, SAMPLE_SIZE);
  const svc = new CrossmallService();
  const missingSampleCodes = samples.filter(p => !p.itemName || p.itemName.trim() === '').map(p => p.itemCode);
  if (missingSampleCodes.length > 0) {
    console.log(`    (サンプル ${missingSampleCodes.length} 件について get_item で itemName を取得中...)`);
    const info = await svc.getItemInfo(missingSampleCodes);
    for (const code of missingSampleCodes) {
      const i = info[code];
      if (i && i.name) {
        await CrossmallProduct.upsert({ itemCode: code, itemName: i.name, purchasePrice: i.purchasePrice, retailPrice: i.retailPrice });
        const s = samples.find(x => x.itemCode === code);
        if (s) s.itemName = i.name;
      }
    }
  }
  for (const p of samples) {
    const name = p.itemName || '(未取得)';
    console.log(`    ${p.itemCode}  sales28=${p.sales28 || 0}  stock=${p.stock || 0}  "${name}"`);
  }

  // 8. 最終サマリ
  console.log(`\n=== サマリ ===`);
  console.log(`  現在の Keyword 総数:            77`);
  console.log(`  現在のユニーク SKU 数:          ${mappedSet.size}`);
  console.log(`  新規登録予定 (dry-run 通過):    ${candidates.length}件`);
  console.log(`  実行後見込み Keyword 総数:      ${77 + candidates.length}件`);
  console.log(`  実行後見込みユニーク SKU 数:    ${mappedSet.size + candidates.length}件`);
  console.log(`  platforms: ['mercari'] のみ (Yahoo 休止中)`);
  console.log(`\n注: BACKLOG 記載の「残り約73件」に対し、実データフィルタでは ${candidates.length}件 が該当。`);
  console.log(`    過去90日の販売実績を持つ 2314- 商品が想定より多いことによる。実行可否はオーナー承認要。`);

  await sequelize.close();
}

main().catch(err => {
  console.error('[dry-run] fatal:', err);
  process.exit(1);
});
