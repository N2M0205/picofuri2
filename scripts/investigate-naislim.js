#!/usr/bin/env node
// Task 1: ナイスリム系 (id=55/65) の「0件検知」矛盾の原因調査
// 読み取り専用、DB書き換えなし

'use strict';

require('dotenv').config();
const { sequelize, Keyword, DetectedItem, CrossmallProduct } = require('../src/models');
const MercariApiScraper = require('../src/scrapers/MercariApiScraper');
const FilterService = require('../src/services/FilterService');
const ngWords = require('../src/config/ngWords');

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const filter = new FilterService();
  const scraper = new MercariApiScraper();
  await scraper.initialize();

  const targets = [55, 65];
  for (const id of targets) {
    console.log(`\n\n============ id=${id} ============`);
    const kw = await Keyword.findByPk(id, { raw: true });
    if (!kw) { console.log('  存在しない'); continue; }
    console.log('keyword:', kw.keyword);
    console.log('crossmallItemCode:', kw.crossmallItemCode);
    console.log('minPrice/maxPrice:', kw.minPrice, '/', kw.maxPrice);
    console.log('globalExcludeEnabled:', kw.globalExcludeEnabled);
    console.log('excludeKeywords:', kw.excludeKeywords);
    console.log('platforms:', kw.platforms);
    console.log('isActive:', kw.isActive);

    // 同 crossmallItemCode の他 keyword を全部列挙
    if (kw.crossmallItemCode) {
      const sameCode = await Keyword.findAll({
        where: { crossmallItemCode: kw.crossmallItemCode },
        raw: true,
      });
      console.log(`\n同 itemCode(${kw.crossmallItemCode}) 全 keyword:`);
      for (const k of sameCode) {
        const detCount = await DetectedItem.count({ where: { keywordId: k.id } });
        console.log(`  id=${k.id} "${k.keyword}" detCount=${detCount} active=${k.isActive}`);
      }

      // 同 itemCode の CrossmallProduct 情報
      const product = await CrossmallProduct.findOne({
        where: { itemCode: kw.crossmallItemCode }, raw: true,
      });
      if (product) {
        console.log(`CrossmallProduct: stock=${product.stock} sales28=${product.sales28}`);
      } else {
        console.log('CrossmallProduct: 未登録');
      }
    }

    // 直近30日の DetectedItem を全 keyword (同itemCode) で列挙
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const sameCodeIds = kw.crossmallItemCode
      ? (await Keyword.findAll({ where: { crossmallItemCode: kw.crossmallItemCode }, raw: true })).map(k => k.id)
      : [id];
    const recentDetected = await DetectedItem.findAll({
      where: {
        keywordId: sameCodeIds,
        createdAt: { [require('sequelize').Op.gte]: thirtyDaysAgo }
      },
      order: [['createdAt', 'DESC']],
      limit: 20,
      raw: true,
    });
    console.log(`\n同itemCode配下の直近30日 DetectedItem: ${recentDetected.length}件 (上位20件)`);
    for (const d of recentDetected) {
      console.log(`  [${d.platform}] kwId=${d.keywordId} price=${d.price} notified=${d.notified} "${d.title.substring(0, 50)}"`);
    }

    // Mercari 検索して、各アイテムに対して matchesKeyword + LayerA を実際に評価
    console.log(`\n>>> Mercari 検索実行 & LayerA まで評価`);
    try {
      const items = await scraper.search(kw.keyword);
      console.log(`  Mercari 返却: ${items.length}件`);
      let matchesPass = 0;
      let layerAPass = 0;
      const rejections = { matchesKeyword: 0, layerA: {} };
      for (const item of items) {
        const m = filter.matchesKeyword(item.title, kw.keyword);
        if (!m) {
          rejections.matchesKeyword++;
          continue;
        }
        matchesPass++;
        const l = filter.check(item, kw);
        if (!l.pass) {
          rejections.layerA[l.reason] = (rejections.layerA[l.reason] || 0) + 1;
          console.log(`  弾き: "${item.title.substring(0, 60)}" → ${l.reason}`);
          continue;
        }
        layerAPass++;
        // 通過した場合、DB既存チェック
        const existing = await DetectedItem.findOne({ where: { itemId: item.id }, raw: true });
        if (existing) {
          console.log(`  通過(既存): itemId=${item.id} kwId=${existing.keywordId} notified=${existing.notified} "${item.title.substring(0, 50)}"`);
        } else {
          console.log(`  通過(新規): itemId=${item.id} price=${item.price} "${item.title.substring(0, 50)}"`);
        }
      }
      console.log(`\n  matchesKeyword 通過: ${matchesPass}/${items.length}件 (弾き ${rejections.matchesKeyword}件)`);
      console.log(`  LayerA 通過: ${layerAPass}/${matchesPass}件`);
      console.log(`  LayerA 却下理由:`);
      for (const [reason, count] of Object.entries(rejections.layerA)) {
        console.log(`    - ${reason}: ${count}件`);
      }
    } catch (e) {
      console.error('  Mercari 検索エラー:', e.message);
    }
  }

  // 追加: NG語句リストの表示
  console.log(`\n\n============ NG語句リスト（LayerAで適用） ============`);
  console.log(ngWords.join(', '));

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
