#!/usr/bin/env node
// id=38「セノッピー」の excludeKeywords に "CHEWABLE" を追加した副作用チェック。
// 既存の id=38 通知履歴に対し、新 exclude 設定を適用したときに
// 「本来通知されるべきセノッピー単体商品が誤って除外されないか」を確認。
//
// 判定基準:
//   - excludeKeywords は case-insensitive で完全部分一致 (title.includes)
//   - "CHEWABLE" は全て大文字英字なので、日本語商品名や小文字混じり
//     "chewable" 表記があれば新たに除外される
//   - 本来通知したい「セノッピー グミ ブドウ味」等の非 CHEWABLE 商品は
//     影響を受けないはず

'use strict';

require('dotenv').config();
const { sequelize } = require('../src/models');
const FilterService = require('../src/services/FilterService');
const filter = new FilterService();

const KW38_NEW = {
  keyword: 'セノッピー',
  minPrice: 1900,
  maxPrice: 99999,
  excludeKeywords: 'チュアブル,CHEWABLE', // 修正後
  globalExcludeEnabled: true,
};
const KW38_OLD = { ...KW38_NEW, excludeKeywords: 'チュアブル' }; // 修正前

async function main() {
  const [rows] = await sequelize.query(
    "SELECT title, price, platform, listedAt FROM DetectedItems WHERE keywordId = 38 AND notified = 1 ORDER BY notifiedAt DESC LIMIT 300"
  );
  console.log('=== id=38 直近300件の通知に対する新旧 exclude 判定比較 ===');

  let sameOk = 0;
  let newlyExcluded = []; // 旧 pass 新 reject
  let stillPass = 0;
  let alreadyExcluded = 0; // 旧 reject 新 reject
  for (const r of rows) {
    const item = { title: r.title, price: r.price, platform: r.platform, listedAt: r.listedAt };
    const oldRes = filter.check(item, KW38_OLD);
    const newRes = filter.check(item, KW38_NEW);
    if (oldRes.pass && newRes.pass) { sameOk++; stillPass++; }
    else if (oldRes.pass && !newRes.pass) newlyExcluded.push({ title: r.title, price: r.price, newReason: newRes.reason });
    else if (!oldRes.pass && !newRes.pass) alreadyExcluded++;
  }

  console.log(`  総件数: ${rows.length}`);
  console.log(`  変化なし (新旧共に通過): ${stillPass}`);
  console.log(`  変化なし (新旧共に除外): ${alreadyExcluded}`);
  console.log(`  新たに除外された (副作用の可能性): ${newlyExcluded.length}`);
  if (newlyExcluded.length) {
    console.log('\n  === 新たに除外される title (先頭30件) ===');
    newlyExcluded.slice(0, 30).forEach(r => console.log(`    [${r.newReason}]  ¥${r.price}  "${r.title.slice(0, 60)}"`));
    if (newlyExcluded.length > 30) console.log(`    ... 他 ${newlyExcluded.length - 30} 件`);
  }

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
