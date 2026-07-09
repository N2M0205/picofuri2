#!/usr/bin/env node
// Task 2 pre-check: 同SKU統合2組の DetectedItem 実績を再確認
// - 2314-001247: id=17 vs id=16
// - 2314-000192: id=20 vs id=22
// 読み取り専用

'use strict';

require('dotenv').config();
const { sequelize, Keyword, DetectedItem } = require('../src/models');

async function report(itemCode, keepId, deleteId) {
  console.log(`\n=== ${itemCode} ===`);
  const all = await Keyword.findAll({ where: { crossmallItemCode: itemCode }, raw: true });
  for (const k of all) {
    const total = await DetectedItem.count({ where: { keywordId: k.id } });
    const notified = await DetectedItem.count({ where: { keywordId: k.id, notified: true } });
    const last = await DetectedItem.findOne({
      where: { keywordId: k.id },
      order: [['createdAt', 'DESC']],
      raw: true,
    });
    const lastDate = last ? new Date(last.createdAt).toISOString().replace(/T.+/, '') : 'N/A';
    console.log(`  id=${k.id} "${k.keyword}" detected=${total} notified=${notified} last=${lastDate}`);
  }
  const keep = all.find(k => k.id === keepId);
  const del  = all.find(k => k.id === deleteId);
  console.log(`  --> 判断案: 残す id=${keepId}(${keep?.keyword}) / 削除 id=${deleteId}(${del?.keyword})`);
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  await report('2314-001247', 17, 16);
  await report('2314-000192', 20, 22);

  // .env allowlist 確認
  const allowlist = process.env.YAHOO_KEYWORD_ALLOWLIST || '';
  console.log(`\n=== .env YAHOO_KEYWORD_ALLOWLIST ===`);
  console.log(`  値: "${allowlist}"`);
  const items = allowlist.split(',').map(s => s.trim()).filter(Boolean);
  const del1 = await Keyword.findByPk(16, { raw: true });
  const del2 = await Keyword.findByPk(22, { raw: true });
  if (del1 && items.includes(del1.keyword)) console.log(`  ⚠️ 削除対象 "${del1.keyword}" が allowlist に含まれる`);
  if (del2 && items.includes(del2.keyword)) console.log(`  ⚠️ 削除対象 "${del2.keyword}" が allowlist に含まれる`);
  if ((!del1 || !items.includes(del1.keyword)) && (!del2 || !items.includes(del2.keyword))) {
    console.log('  allowlist 更新不要');
  }

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
