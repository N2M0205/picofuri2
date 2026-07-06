#!/usr/bin/env node
// KeywordGroupService の動作確認テスト（実DB接続、読み取り専用）
// 使い方: node scripts/test-keyword-groups.js

'use strict';

const { sequelize, Keyword } = require('../src/models');
const {
  getKeywordGroups,
  getKeywordsByItemCode,
  listUniqueSkus,
} = require('../src/services/KeywordGroupService');

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  // ベースライン: 全キーワード件数
  const totalKw = await Keyword.count();
  console.log(`[test] baseline: Keyword total = ${totalKw}`);

  console.log('\n[test-1] getKeywordGroups() の基本形');
  const groups = await getKeywordGroups();
  assert(Array.isArray(groups), 'returns an array');
  assert(groups.length > 0, 'contains at least one group');

  console.log('\n[test-2] グループ内のキーワード合計が全キーワード数に一致');
  const sumKw = groups.reduce((a, g) => a + g.keywords.length, 0);
  assert(sumKw === totalKw, `sum(group.keywords) === Keyword.count() (${sumKw} === ${totalKw})`);

  console.log('\n[test-3] 同一itemCodeで共有される既知のペアが同グループに入る');
  // 実データベースライン: 各itemCodeに複数キーワードが紐づくペア
  const knownPairs = [
    { itemCode: '2314-001346', expectAny: ['トイラボ', 'ToyLaBO'] },
    { itemCode: '2314-001848', expectAny: ['尿酸と脂肪のダブルバスター', '尿酸と脂肪'] },
    { itemCode: '2314-001247', expectAny: ['SENOPPY CHEWABLE', 'セノッピー チュアブル'] },
    { itemCode: '2314-000192', expectAny: ['ルックルック イヌリンプラス', 'ルックルック イヌリン'] },
    { itemCode: '2314-001811', expectAny: ['りそうのコーヒー', 'risou no cofffee'] },
    { itemCode: '2314-001914', expectAny: ['ナイスリムサポート エラグ酸のチカラ', 'ナイスリム'] },
    { itemCode: '2314-000546', expectAny: ['nico 石鹸', 'ニコ せっけん'] },
    { itemCode: '2314-001373', expectAny: ['バルクス レッドギア', 'VALX RED GEAR'] },
  ];
  for (const pair of knownPairs) {
    const g = groups.find(x => x.itemCode === pair.itemCode);
    const kwList = g ? g.keywords.map(k => k.keyword) : [];
    const allInSameGroup = pair.expectAny.every(name => kwList.includes(name));
    assert(g && g.keywords.length >= 2 && allInSameGroup,
      `itemCode=${pair.itemCode} : ${pair.expectAny.join(' + ')} が同グループ`);
  }

  console.log('\n[test-4] crossmallItemCode=null のキーワードは単独グループ');
  const nullKws = await Keyword.findAll({ where: { crossmallItemCode: null } });
  console.log(`  (null itemCode の実データ: ${nullKws.length}件)`);
  const standaloneGroups = groups.filter(g => g.itemCode === null);
  assert(standaloneGroups.length === nullKws.length,
    `単独グループ数 === null-itemCode キーワード数 (${standaloneGroups.length} === ${nullKws.length})`);
  assert(standaloneGroups.every(g => g.keywords.length === 1),
    '各単独グループのキーワード数は1');

  console.log('\n[test-5] getKeywordsByItemCode の正常/異常系');
  const t1 = await getKeywordsByItemCode('2314-001346');
  assert(t1.length >= 2 && t1.some(k => k.keyword === 'トイラボ'),
    "getKeywordsByItemCode('2314-001346') はトイラボを含む");
  const t2 = await getKeywordsByItemCode(null);
  assert(Array.isArray(t2) && t2.length === 0, 'getKeywordsByItemCode(null) === []');
  const t3 = await getKeywordsByItemCode('');
  assert(Array.isArray(t3) && t3.length === 0, "getKeywordsByItemCode('') === []");
  const t4 = await getKeywordsByItemCode('2314-NONEXISTENT');
  assert(Array.isArray(t4) && t4.length === 0, '存在しないitemCode → []');

  console.log('\n[test-6] listUniqueSkus');
  const skus = await listUniqueSkus();
  const kwWithCode = await Keyword.count({ where: { crossmallItemCode: { [require('sequelize').Op.not]: null } } });
  const uniqueCodes = new Set(
    (await Keyword.findAll({ where: { crossmallItemCode: { [require('sequelize').Op.not]: null } }, raw: true }))
      .map(r => (r.crossmallItemCode || '').trim())
      .filter(Boolean)
  );
  assert(skus.length === uniqueCodes.size,
    `listUniqueSkus().length === unique itemCode 件数 (${skus.length} === ${uniqueCodes.size})`);
  assert(skus.every(s => typeof s === 'string' && s.length > 0),
    '全要素が非空文字列');
  console.log(`  (参考) 未マッピングキーワード ${totalKw - kwWithCode}件、ユニークSKU ${skus.length}件`);

  console.log('\n=== 結果 ===');
  console.log(`passed=${passed}, failed=${failed}`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('[test] fatal:', err);
  process.exit(1);
});
