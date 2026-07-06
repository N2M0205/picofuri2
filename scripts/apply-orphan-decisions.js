#!/usr/bin/env node
// Owner 承認済み: orphan調査 (a)(b)(c) の反映
//
// - A 27件 -> アスハダ 2314-001498 を除外して 26件を新規登録 (platforms=['mercari'])
// - C-1: id=14 デオエース 40ml の crossmallItemCode を 2314-001070 -> 2314-0001070
// - C-2: id=9 アスハダ 30ml の crossmallItemCode = 2314-001498 (元 null)

'use strict';

require('dotenv').config();
const { sequelize, Keyword, CrossmallProduct } = require('../src/models');
const CrossmallService = require('../src/services/CrossmallService');

// A リストからアスハダ (2314-001498) を除外した 26件
// 各エントリは { base, name } — name は CROSSMALL master の正式名
const A_BASES_MINUS_ASUHADA = [
  { base: '2314-001097', name: 'シミュート 30g 薬用美白クリーム' },
  { base: '2314-001233', name: 'リンカル S 120粒 180g 栄養補助食品' },
  { base: '2314-000699', name: 'コーズシックス' },
  { base: '2314-000724', name: 'ミホレ MIHORE スカルプケア 80ml' },
  { base: '2314-001367', name: 'ラフィーネ アルファ 30本入 1箱' },
  { base: '2314-001222', name: 'アイムピンチ エッセンス 60ml I\'m PINCH' },
  { base: '2314-001292', name: 'ワイルド マンゴーの力 60粒' },
  { base: '2314-001360', name: 'ラクトロン 180粒' },
  { base: '2314-001596', name: 'ホルモ プレミアム ヘアー グロウ エッセンス 80ml HORMO' },
  { base: '2314-001678', name: 'ヘアモア 薬用ヘアローション S 120ml 詰替 リフィル' },
  { base: '2314-001598', name: 'siboloss シボロス 30粒' },
  { base: '2314-000520', name: 'クレムドアン ブラック 300g' },
  { base: '2314-001584', name: 'リフトマキシマイザー 23.5g' },
  { base: '2314-000575', name: 'チュラコス わらびはだ 30g' },
  { base: '2314-001524', name: 'ヘアモア スカルプエッセンス 薬用ヘアローション S 120ml 女性用 育毛剤' },
  { base: '2314-000620', name: 'イミニ リペアセラム50mL' },
  { base: '2314-000695', name: 'グリナ 味の素 30本入り' },
  { base: '2314-001515', name: '蓬緑 よもぎみどり 越後酵素 720ml' },
  { base: '2314-000708', name: 'シミトリー simiTRY オールインワンジェル 60g' },
  { base: '2314-001164', name: 'エクス オーガ ティアリー エクスオーガ' },
  { base: '2314-001338', name: '美的ヌーボ プレミアム Plus 30包' },
  { base: '2314-001529', name: '鮫珠 肝油 新パッケージ 62粒' },
  { base: '2314-001655', name: 'ジムジル カラーシャンプー 250ml ダークブラウン 白髪染め Jjimjil' },
  { base: '2314-001356', name: 'マリノブライズ 20ml MARINO BRISE' },
  { base: '2314-001213', name: 'スピライズ スティック状美容液' },
  { base: '2314-001304', name: 'アイムピンチ エッセンス 30ml I\'m PINCH' },
];

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  await CrossmallProduct.sync({ alter: true });

  const beforeCount = await Keyword.count();
  console.log(`[apply] 開始時 Keyword 総数: ${beforeCount}`);

  // ===== C 修正: 既存キーワードの itemCode を更新 =====
  console.log('\n[C] 既存キーワードの itemCode 修正...');

  // C-1: id=14 デオエース 40ml
  const kw14 = await Keyword.findByPk(14);
  if (!kw14) { console.error('  id=14 not found'); process.exit(1); }
  console.log(`  id=14 「${kw14.keyword}」 crossmallItemCode: ${kw14.crossmallItemCode} -> 2314-0001070`);
  await kw14.update({ crossmallItemCode: '2314-0001070' });

  // C-2: id=9 アスハダ 30ml
  const kw9 = await Keyword.findByPk(9);
  if (!kw9) { console.error('  id=9 not found'); process.exit(1); }
  console.log(`  id=9 「${kw9.keyword}」 crossmallItemCode: ${kw9.crossmallItemCode} -> 2314-001498`);
  await kw9.update({ crossmallItemCode: '2314-001498' });

  // アスハダのベース (2314-001498) を CrossmallProduct に upsert (baseItemCode = self)
  console.log('  CrossmallProduct 2314-001498 を base として登録...');
  const svc = new CrossmallService();
  const asuhInfo = await svc.getItemInfo(['2314-001498']);
  const asuhName = asuhInfo['2314-001498']?.name || 'アスハダ ASHADA パーフェクトクリアエッセンス 30ml';
  await CrossmallProduct.upsert({
    itemCode: '2314-001498',
    itemName: asuhName,
    purchasePrice: asuhInfo['2314-001498']?.purchasePrice || 0,
    retailPrice: asuhInfo['2314-001498']?.retailPrice || 0,
    baseItemCode: '2314-001498',
  });
  // 対応する n派生 2314-001498n の baseItemCode を更新
  await CrossmallProduct.update({ baseItemCode: '2314-001498' }, { where: { itemCode: '2314-001498n' } });

  // 同様に C-1 デオエース base 2314-0001070 を CrossmallProduct に登録 (もし未登録なら)
  console.log('  CrossmallProduct 2314-0001070 を base として登録...');
  const dInfo = await svc.getItemInfo(['2314-0001070']);
  const dName = dInfo['2314-0001070']?.name || 'デオエースEX プラス 40ml';
  await CrossmallProduct.upsert({
    itemCode: '2314-0001070',
    itemName: dName,
    purchasePrice: dInfo['2314-0001070']?.purchasePrice || 0,
    retailPrice: dInfo['2314-0001070']?.retailPrice || 0,
    baseItemCode: '2314-0001070',
  });
  await CrossmallProduct.update({ baseItemCode: '2314-0001070' }, { where: { itemCode: '2314-0001070n' } });

  // ===== A 26件: 新規登録 =====
  console.log('\n[A] A 26件を新規登録 (platforms=[\'mercari\'])...');
  const existingKw = new Set(
    (await Keyword.findAll({ attributes: ['keyword'], raw: true })).map(r => r.keyword)
  );
  const existingCodes = new Set(
    (await Keyword.findAll({ attributes: ['crossmallItemCode'], raw: true }))
      .map(r => r.crossmallItemCode).filter(Boolean)
  );

  // ベースがなければ CrossmallProduct に upsert (name とともに)
  const codesToUpsert = A_BASES_MINUS_ASUHADA.map(e => e.base);
  const existingProducts = new Set(
    (await CrossmallProduct.findAll({
      where: { itemCode: codesToUpsert },
      attributes: ['itemCode'],
      raw: true,
    })).map(r => r.itemCode)
  );
  const needBaseProduct = codesToUpsert.filter(c => !existingProducts.has(c));
  if (needBaseProduct.length > 0) {
    console.log(`  CrossmallProduct に base 未登録: ${needBaseProduct.length}件 → upsert`);
    const info = await svc.getItemInfo(needBaseProduct);
    for (const c of needBaseProduct) {
      const i = info[c] || {};
      await CrossmallProduct.upsert({
        itemCode: c,
        itemName: i.name || A_BASES_MINUS_ASUHADA.find(e => e.base === c).name,
        purchasePrice: i.purchasePrice || 0,
        retailPrice: i.retailPrice || 0,
        baseItemCode: c,
      });
    }
    // 対応する n派生 の baseItemCode を更新
    for (const c of needBaseProduct) {
      await CrossmallProduct.update({ baseItemCode: c }, { where: { itemCode: c + 'n' } });
    }
  }

  let created = 0, skippedName = 0, skippedCode = 0;
  for (const e of A_BASES_MINUS_ASUHADA) {
    if (existingKw.has(e.name)) { skippedName++; console.log(`  skip name-dup: ${e.name}`); continue; }
    if (existingCodes.has(e.base)) { skippedCode++; console.log(`  skip code-dup: ${e.base}`); continue; }
    await Keyword.create({
      keyword: e.name,
      platforms: ['mercari'],
      crossmallItemCode: e.base,
      excludeKeywords: '',
      isActive: true,
      minPrice: 0,
      maxPrice: 999999,
      globalExcludeEnabled: true,
    });
    created++;
  }
  const afterCount = await Keyword.count();
  console.log(`\n[A] 結果: 新規作成=${created} / name-dup skip=${skippedName} / code-dup skip=${skippedCode}`);
  console.log(`    Keyword 総数: ${beforeCount} -> ${afterCount} (+${afterCount - beforeCount})`);

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
