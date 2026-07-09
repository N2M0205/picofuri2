#!/usr/bin/env node
// 短縮適用後の StarredOos 15件、通知の識別可能性を確認 (読み取り専用)

'use strict';
require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');
const TierClassifier = require('../src/services/TierClassifier');

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const total = await Keyword.count();
  console.log(`Keyword 総数: ${total}`);

  const classes = await TierClassifier.classifyAll();
  console.log(`Tier: hot=${classes.hot.length} warm=${classes.warm.length} ` +
    `cold=${classes.cold.length} starredOos=${classes.starredOos?.length || 0}\n`);

  console.log('=== StarredOos 15件の現在の keyword ===');
  const starredIds = classes.starredOos.map(k => k.id);
  const starredKws = await Keyword.findAll({
    where: { id: starredIds },
    order: [['id', 'ASC']],
    raw: true,
  });
  for (const k of starredKws) {
    console.log(`  id=${String(k.id).padStart(3)} "${k.keyword}" (code=${k.crossmallItemCode})`);
  }

  // 全 keyword に重複がないことを確認
  console.log('\n=== keyword 重複チェック ===');
  const allKws = await Keyword.findAll({ raw: true });
  const kwMap = new Map();
  for (const k of allKws) {
    if (!kwMap.has(k.keyword)) kwMap.set(k.keyword, []);
    kwMap.get(k.keyword).push(k.id);
  }
  const dupes = [...kwMap.entries()].filter(([, ids]) => ids.length > 1);
  if (dupes.length === 0) {
    console.log('  ✅ keyword 重複なし');
  } else {
    console.log(`  ⚠️ ${dupes.length} 件の重複あり:`);
    for (const [kw, ids] of dupes) console.log(`    "${kw}" ids=[${ids.join(',')}]`);
  }

  await sequelize.close();
}
main().catch(e => { console.error(e); process.exit(1); });
