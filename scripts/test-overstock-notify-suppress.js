#!/usr/bin/env node
// ScrapingService._processItems の「overstock 通知抑止」化テスト
// (2026-07-30 直近14日 0件検知調査の実装1: feat/overstock-notify-suppress)
//
// 検証仕様:
//   旧挙動: overstock 判定 (在庫日数 > 25日) の商品は DetectedItem.create すら呼ばれず
//           完全に捨てられていた。結果、Mercari 出品はあるのに DB 上 0件検知の状態が
//           構造的に発生していた (67 キーワード / 226 = 30%)
//   新挙動: overstock 判定でも DetectedItem.create は必ず実行し、notified=false のまま残す。
//           通知だけを抑止する。
//
// テストケース:
//   Case A (overstock): DetectedItem 行が作成される AND 通知は発火しない
//   Case B (normal)   : DetectedItem 行が作成される AND 通知が発火する (baseline 変更なし)
//   Case C (LayerA reject): DetectedItem 行が作成されない AND 通知も発火しない (baseline)
//
// 実装: 本番 DB に対して synthetic な itemId (test-suppress-*) で書き込み、
//       通知先は notification.notifyNewItem を spy でモックして送信は行わない。
//       テスト終了時に synthetic 行を必ず削除する。

'use strict';

require('dotenv').config();
const { sequelize, Keyword, CrossmallProduct, DetectedItem } = require('../src/models');
const ScrapingService = require('../src/services/ScrapingService');

const TEST_ITEM_PREFIX = 'test-suppress-';

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

async function cleanup() {
  await DetectedItem.destroy({ where: { itemId: { [require('sequelize').Op.like]: TEST_ITEM_PREFIX + '%' } } });
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  await cleanup();

  const svc = new ScrapingService();
  await svc.mercariScraper.initialize();

  // 通知先を spy に差し替え (実際の Telegram/LINE は叩かない)
  const notifiedItems = [];
  svc.notification.notifyNewItem = async (item, keyword, product) => {
    notifiedItems.push({ itemId: item.id, keywordId: keyword.id });
  };

  // overstock 判定される既存キーワードを流用: id=50 ペプチア (stock=14/s28=9 → 44日)
  const overstockKw = await Keyword.findByPk(50);
  const overstockProd = await CrossmallProduct.findOne({ where: { itemCode: overstockKw.crossmallItemCode } });
  console.log(`[baseline] overstock kw id=${overstockKw.id} "${overstockKw.keyword}"`);
  console.log(`           product ${overstockProd.itemCode} stock=${overstockProd.stock} sales28=${overstockProd.sales28}`);
  const stockDays = Math.round(overstockProd.stock * 28 / overstockProd.sales28);
  assert(stockDays > 25, `overstock keyword の在庫日数が閾値超え (${stockDays}日 > 25日)`);

  // 非overstock 判定される既存キーワードを流用: 現在 hot な id を検索
  // ここでは stock>0, sales28>0, stockDays<=25 のキーワード SKU を DB から探索
  const { classifyAll } = require('../src/services/TierClassifier');
  const cls = await classifyAll();
  const hotKw = cls.hot[0];
  const hotProd = hotKw ? await CrossmallProduct.findOne({ where: { itemCode: hotKw.crossmallItemCode } }) : null;
  console.log(`[baseline] normal kw id=${hotKw?.id} "${hotKw?.keyword}"`);
  if (hotProd) {
    const d = Math.round(hotProd.stock * 28 / hotProd.sales28);
    console.log(`           product ${hotProd.itemCode} stock=${hotProd.stock} sales28=${hotProd.sales28} (${d}日)`);
    assert(d <= 25, `normal keyword の在庫日数が閾値以下 (${d}日 <= 25日)`);
  } else {
    console.error('[fatal] Hot tier にキーワードが 1件もない、テスト不能');
    process.exit(1);
  }

  // ---------- Case A: overstock ----------
  console.log('\n[test-A] overstock 商品: DetectedItem 作成 かつ 通知抑止');
  notifiedItems.length = 0;
  const itemA = {
    id: TEST_ITEM_PREFIX + 'A-' + Date.now(),
    platform: 'mercari',
    title: overstockKw.keyword + ' テスト用商品タイトル',
    price: 5500, // overstockKw の min=4000/max=99999 範囲内
    imageUrl: '',
    itemUrl: 'https://jp.mercari.com/item/dummy',
    listedAt: new Date(),
    listingCount: null,
  };
  const scanState = { notifyCount: 0, cappedCount: 0, capHitLogged: false, yahooRateLimited: false };
  await svc._processItems([itemA], overstockKw, scanState, 0);
  const rowA = await DetectedItem.findOne({ where: { itemId: itemA.id } });
  assert(!!rowA, 'DetectedItem 行が作成される');
  assert(rowA && rowA.notified === false, '  notified=false で残る');
  assert(rowA && rowA.keywordId === overstockKw.id, `  keywordId=${overstockKw.id} と一致`);
  assert(notifiedItems.length === 0, '通知が発火しない (spy 呼び出し 0回)');

  // ---------- Case B: normal ----------
  console.log('\n[test-B] 通常商品: DetectedItem 作成 かつ 通知発火');
  notifiedItems.length = 0;
  const itemB = {
    id: TEST_ITEM_PREFIX + 'B-' + Date.now(),
    platform: 'mercari',
    title: hotKw.keyword + ' テスト用商品タイトル',
    price: Math.max(hotKw.minPrice + 100, 1000),
    imageUrl: '',
    itemUrl: 'https://jp.mercari.com/item/dummy',
    listedAt: new Date(),
    listingCount: null,
  };
  // 通知はスパムを避けるため、cap を 1 に設定 (テスト内では 1件でも通知が発火することの確認だけで十分)
  const scanStateB = { notifyCount: 0, cappedCount: 0, capHitLogged: false, yahooRateLimited: false };
  await svc._processItems([itemB], hotKw, scanStateB, 1);
  const rowB = await DetectedItem.findOne({ where: { itemId: itemB.id } });
  assert(!!rowB, 'DetectedItem 行が作成される');
  assert(rowB && rowB.keywordId === hotKw.id, `  keywordId=${hotKw.id} と一致`);
  assert(notifiedItems.length === 1, `通知が発火する (spy 呼び出し ${notifiedItems.length}回、期待 1回)`);
  assert(rowB && rowB.notified === true, '  notified=true に更新される');

  // ---------- Case C: LayerA reject ----------
  console.log('\n[test-C] LayerA 除外商品 (下限価格未満): DetectedItem 作成なし かつ 通知なし');
  notifiedItems.length = 0;
  const itemC = {
    id: TEST_ITEM_PREFIX + 'C-' + Date.now(),
    platform: 'mercari',
    title: overstockKw.keyword + ' テスト用商品',
    price: overstockKw.minPrice - 100, // 下限未満で LayerA 除外
    imageUrl: '',
    itemUrl: 'https://jp.mercari.com/item/dummy',
    listedAt: new Date(),
    listingCount: null,
  };
  const scanStateC = { notifyCount: 0, cappedCount: 0, capHitLogged: false, yahooRateLimited: false };
  await svc._processItems([itemC], overstockKw, scanStateC, 0);
  const rowC = await DetectedItem.findOne({ where: { itemId: itemC.id } });
  assert(!rowC, 'DetectedItem 行が作成されない (LayerA で reject)');
  assert(notifiedItems.length === 0, '通知が発火しない');

  // ---------- teardown ----------
  await cleanup();
  await sequelize.close();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async e => {
  console.error(e);
  try { await cleanup(); await sequelize.close(); } catch {}
  process.exit(1);
});
