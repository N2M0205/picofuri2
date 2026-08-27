#!/usr/bin/env node
// LayerA 経過時間閾値の緩和 dry-run
// (2026-07-30 直近14日 0件検知調査、実装 ②検討)
//
// 目的:
//   layer_a_max_hours=48 (現状) を 72 / 96 / 168h に緩めた場合、
//   何件が「LayerA 通過が新たに増える」か、Cold tier中心に測定する。
//   実際に注意すべきは「overstock 通知抑止を通り抜けて実通知に至る差分」なので、
//   overstock ドロップ後カウントも別途集計する。
//
// 手法:
//   - 全 Cold キーワードで Mercari ライブ検索
//   - 各 item について matchesKeyword (現行 and-full、③未 merge 前提) + LayerA 中の
//     経過時間以外の check (価格・NG・除外) を通過することを確認
//   - 経過時間の残時間バケット (<=48/48-72/72-96/96-168/>168) に振り分け
//   - overstock 判定を掛けて「通知に至る」件数も計算
//
// 出力: 標準出力に集計、DB 書込みなし・通知なし

'use strict';

require('dotenv').config();
const MercariApiScraper = require('../src/scrapers/MercariApiScraper');
const FilterService = require('../src/services/FilterService');
const { classifyAll } = require('../src/services/TierClassifier');
const { CrossmallProduct, Keyword } = require('../src/models');

async function main() {
  const cls = await classifyAll();
  const cold = cls.cold;
  console.log(`[dry-run-max-hours] Cold tier キーワード ${cold.length}件を対象`);

  const scraper = new MercariApiScraper();
  await scraper.initialize();
  const filter = new FilterService();

  // 事前に product をまとめて取得 (overstock 判定用)
  const codes = [...new Set(cold.map(k => k.crossmallItemCode).filter(Boolean))];
  const prods = await CrossmallProduct.findAll({ where: { itemCode: codes }, raw: true });
  const pmap = new Map(prods.map(p => [p.itemCode, p]));

  // カウンタ
  const buckets = { '<=48h': 0, '48-72h': 0, '72-96h': 0, '96-168h': 0, '>168h': 0 };
  const bucketsAfterOverstock = { '<=48h': 0, '48-72h': 0, '72-96h': 0, '96-168h': 0, '>168h': 0 };
  const perKwDelta = new Map(); // kwId -> {kw, ...deltas}
  let totalRaw = 0, totalMatched = 0, totalCheckedForAge = 0, totalPreAgeReject = 0;

  const layerACheckExceptAge = (item, keyword) => {
    if (keyword.minPrice > 0 && item.price < keyword.minPrice) return { pass: false, reason: '下限価格未満' };
    if (keyword.maxPrice < 999999 && item.price > keyword.maxPrice) return { pass: false, reason: '上限価格超過' };
    // NG 語句
    const ngWords = require('../src/config/ngWords.js');
    const title = (item.title || '').toLowerCase();
    for (const word of ngWords) if (title.includes(word.toLowerCase())) return { pass: false, reason: 'NG' };
    // グローバル除外
    if (keyword.globalExcludeEnabled !== false) {
      for (const word of ['空箱','サンプル']) if (title.includes(word.toLowerCase())) return { pass: false, reason: 'globalEx' };
    }
    // 個別除外
    const inds = (keyword.excludeKeywords||'').split(',').map(w=>w.trim()).filter(Boolean);
    for (const word of inds) if (title.includes(word.toLowerCase())) return { pass: false, reason: 'indEx' };
    return { pass: true };
  };

  const isOverstockFor = (kw) => {
    const p = kw.crossmallItemCode ? pmap.get(kw.crossmallItemCode) : null;
    if (!p) return false;
    return filter.isOverstock(p.stock, p.sales28);
  };

  for (let i = 0; i < cold.length; i++) {
    const kw = cold[i];
    process.stdout.write(`[${String(i+1).padStart(3)}/${cold.length}] ${kw.keyword}\r`);
    let items;
    try { items = await scraper.search(kw.keyword); }
    catch (e) { continue; }
    totalRaw += items.length;
    const overstock = isOverstockFor(kw);
    const localDelta = { kw: kw.keyword, id: kw.id, sku: kw.crossmallItemCode, overstock, b: { '<=48h':0,'48-72h':0,'72-96h':0,'96-168h':0,'>168h':0 } };

    for (const it of items) {
      if (!filter.matchesKeyword(it.title, kw.keyword)) continue; // ③未マージ前提で and-full
      totalMatched++;
      const ageChk = layerACheckExceptAge(it, kw);
      if (!ageChk.pass) { totalPreAgeReject++; continue; }
      if (!it.listedAt) continue; // Yahoo (対象外)、Mercari で listedAt null は稀
      totalCheckedForAge++;
      const hrs = (Date.now() - new Date(it.listedAt).getTime()) / (1000 * 3600);
      let bucket;
      if (hrs <= 48) bucket = '<=48h';
      else if (hrs <= 72) bucket = '48-72h';
      else if (hrs <= 96) bucket = '72-96h';
      else if (hrs <= 168) bucket = '96-168h';
      else bucket = '>168h';
      buckets[bucket]++;
      localDelta.b[bucket]++;
      if (!overstock) bucketsAfterOverstock[bucket]++;
    }
    if (localDelta.b['48-72h'] + localDelta.b['72-96h'] + localDelta.b['96-168h'] + localDelta.b['>168h'] > 0) {
      perKwDelta.set(kw.id, localDelta);
    }
  }
  process.stdout.write('\n\n');

  // 集計: 閾値毎の通過数増分
  const cumul = (up) => {
    const bs = ['<=48h','48-72h','72-96h','96-168h','>168h'];
    let s = 0;
    for (const b of bs) { s += buckets[b]; if (b === up) return s; }
    return s;
  };
  const cumulNotify = (up) => {
    const bs = ['<=48h','48-72h','72-96h','96-168h','>168h'];
    let s = 0;
    for (const b of bs) { s += bucketsAfterOverstock[b]; if (b === up) return s; }
    return s;
  };

  console.log('=== LayerA 通過数 (現行 filter + matchesKeyword=and-full を通過し、経過時間だけがブロッカーになる item) ===');
  console.log(`raw hit total:                  ${totalRaw}`);
  console.log(`matchesKeyword 通過:            ${totalMatched}`);
  console.log(`  うち NG/価格/除外 で reject:  ${totalPreAgeReject}`);
  console.log(`  うち listedAt あり:           ${totalCheckedForAge}`);

  console.log('\n=== 経過時間バケット (Cold 全 keyword 合計、item カウント) ===');
  console.log('bucket   | 全 keyword | overstock 除外後 (実通知の可能性あり)');
  for (const b of ['<=48h','48-72h','72-96h','96-168h','>168h']) {
    console.log((b + '   ').slice(0,8), '|', String(buckets[b]).padStart(10), '|', String(bucketsAfterOverstock[b]).padStart(10));
  }

  console.log('\n=== 閾値ごとの累積通過数 ===');
  console.log('閾値    | 累積通過 (全) | 累積通過 (overstock除外後)');
  const baseline = { all: buckets['<=48h'], nonOs: bucketsAfterOverstock['<=48h'] };
  console.log(' 48h    |', String(cumul('<=48h')).padStart(13), '|', String(cumulNotify('<=48h')).padStart(23), '(現状)');
  console.log(' 72h    |', String(cumul('48-72h')).padStart(13), '|', String(cumulNotify('48-72h')).padStart(23),
    `(+${cumul('48-72h')-baseline.all} / +${cumulNotify('48-72h')-baseline.nonOs})`);
  console.log(' 96h    |', String(cumul('72-96h')).padStart(13), '|', String(cumulNotify('72-96h')).padStart(23),
    `(+${cumul('72-96h')-baseline.all} / +${cumulNotify('72-96h')-baseline.nonOs})`);
  console.log('168h    |', String(cumul('96-168h')).padStart(13), '|', String(cumulNotify('96-168h')).padStart(23),
    `(+${cumul('96-168h')-baseline.all} / +${cumulNotify('96-168h')-baseline.nonOs})`);
  console.log('∞       |', String(cumul('>168h')).padStart(13), '|', String(cumulNotify('>168h')).padStart(23),
    '(参考)');

  // 閾値変更による実質通知増加ライン (overstock 除外後)
  console.log('\n=== 実通知観点の増分 (overstock ドロップ後、現状 48h からの追加) ===');
  console.log(' 48h→72h : 新規通知可能 item 数 =', cumulNotify('48-72h') - baseline.nonOs, '件');
  console.log(' 48h→96h : 新規通知可能 item 数 =', cumulNotify('72-96h') - baseline.nonOs, '件');
  console.log(' 48h→168h: 新規通知可能 item 数 =', cumulNotify('96-168h') - baseline.nonOs, '件');

  // 増加インパクト上位キーワード (48→168h)
  const kwSorted = [...perKwDelta.values()].map(x => ({
    ...x,
    delta48to168: x.b['48-72h'] + x.b['72-96h'] + x.b['96-168h']
  })).sort((a,b) => b.delta48to168 - a.delta48to168);

  console.log('\n=== 増加インパクト上位 Cold keyword (48→168h の累積差分) ===');
  console.log('id  | keyword                             | overstock | 48-72 | 72-96 | 96-168 | >168 | Δ48→168');
  for (const k of kwSorted.slice(0, 20)) {
    console.log(String(k.id).padStart(3), '|', (k.kw + ' '.repeat(35)).slice(0,35),
      '|', String(k.overstock).padStart(9),
      '|', String(k.b['48-72h']).padStart(5),
      '|', String(k.b['72-96h']).padStart(5),
      '|', String(k.b['96-168h']).padStart(6),
      '|', String(k.b['>168h']).padStart(4),
      '|', String(k.delta48to168).padStart(7));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
