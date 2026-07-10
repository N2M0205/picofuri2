#!/usr/bin/env node
// n派生フォールバックのシミュレーションテスト
// - 対象 keyword で ScrapingService._resolveProduct を呼び、
//   採用データソースと sales7/sales28/lastSalePrice/stock を表示
// - NotificationService.buildMessage の判定ライン (📋参考 / ✅ 等) も検証

'use strict';

require('dotenv').config();
const ScrapingService = require('../src/services/ScrapingService');
const NotificationService = require('../src/services/NotificationService');
const { Keyword, sequelize } = require('../src/models');

const TARGET_IDS = [46, 215, 31, 38, 42];
// 46=さかな暮らし (n派生 s28=9)  → 期待: merged
// 215=アイムピンチ 60ml (n派生 s28=16) → 期待: merged
// 31=& wolf 002 (n派生 s28=11)  → 期待: merged
// 38=セノッピー (base s28>0)     → 期待: base 変化なし (回帰チェック)
// 42=スパルト T5 (n派生 s28=1)  → 期待: merged (境界チェック)

async function main() {
  const scraping = new ScrapingService();
  const notif = new NotificationService();

  console.log('=== n派生フォールバック シミュレーション ===\n');

  for (const id of TARGET_IDS) {
    const kw = await Keyword.findByPk(id);
    if (!kw) { console.log(`id=${id}: 見つからず`); continue; }
    const product = await scraping._resolveProduct(kw);
    const src = product?._source || (product ? 'base(直)' : 'null');

    // NotificationService.buildMessage が使う判定を再現
    const stock = product?.stock ?? 0;
    const sales28 = product?.sales28 ?? 0;
    const sales7 = product?.sales7 ?? 0;
    const lsp = product?.lastSalePrice ?? 0;
    const lsd = product?.lastSaleDate ?? null;
    const lspDisplay = lsp > 0 ? `¥${lsp}` : '(参考ラベル)';

    console.log(`id=${id} kw="${kw.keyword}"`);
    console.log(`  code=${kw.crossmallItemCode} source=${src}`);
    console.log(`  stock=${stock} sales7=${sales7} sales28=${sales28} lsp=${lspDisplay} lsd=${lsd}`);

    // 過剰在庫スキップ判定
    const isOverstock = scraping.filter.isOverstock(stock, sales28);
    console.log(`  isOverstock=${isOverstock} (stockDays=${sales28 > 0 ? Math.round(stock / (sales28 / 28)) : 'N/A'})`);

    // 判定ライン
    let judge;
    if (lsp > 0) {
      judge = '判定=通常（価格判定入る）';
    } else {
      judge = '判定=📋 参考';
    }
    console.log(`  ${judge}`);
    console.log('');
  }

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
