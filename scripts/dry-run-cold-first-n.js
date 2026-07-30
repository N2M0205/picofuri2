#!/usr/bin/env node
// Cold tier キーワードに対する matchesKeyword モード変更の dry-run
// (2026-07-30 直近14日 0件検知調査、実装 ③: feat/matches-first-n-cold)
//
// 目的:
//   AND-full (現状) → first-n-tokens (Cold のみ新デフォルト、N=3) の切替が
//   個別キーワードの通過率にどう効くかを、Mercari ライブ検索結果で計測する。
//   DB は一切書き換えない。通知も送らない。
//
// 出力:
//   - 全 Cold キーワード (2026-07-30 時点 201件) について
//     old (and-full) と new (first-n-3) の matchesKeyword 通過数を比較
//   - 差分がプラス (new > old) のキーワードを表示、追加通過するタイトル例つき
//   - サマリ: 影響ありキーワード数、平均通過数増分、想定通知増加ライン
//
// 使い方: node scripts/dry-run-cold-first-n.js [--limit=N]
//   --limit で対象キーワード数を絞れる (デバッグ用)

'use strict';

require('dotenv').config();
const { Keyword } = require('../src/models');
const MercariApiScraper = require('../src/scrapers/MercariApiScraper');
const FilterService = require('../src/services/FilterService');
const { classifyAll } = require('../src/services/TierClassifier');

async function main() {
  const args = process.argv.slice(2).reduce((a, s) => {
    const m = s.match(/^--(\w+)=(.+)$/); if (m) a[m[1]] = m[2]; return a;
  }, {});
  const limit = args.limit ? parseInt(args.limit, 10) : null;

  const cls = await classifyAll();
  let cold = cls.cold;
  if (limit) cold = cold.slice(0, limit);
  console.log(`[dry-run] Cold tier キーワード ${cold.length}件を対象に Mercari ライブ検索`);
  console.log(`[dry-run] mode 比較: OLD=and-full (現状)  vs  NEW=first-n-tokens (N=3、opts.tier='cold')\n`);

  const scraper = new MercariApiScraper();
  await scraper.initialize();
  const filter = new FilterService();

  const summary = {
    kwTotal: cold.length,
    kwChanged: 0,        // OLD と NEW で通過数が異なる
    kwIncreased: 0,      // NEW > OLD
    kwDecreased: 0,      // NEW < OLD (fallback フレーズ一致が効いていた等、稀)
    kwZeroToNonzero: 0,  // OLD 0件 → NEW 1件以上
    totalDeltaMatched: 0,
    kwScrapeError: 0,
    kwEmptyMercari: 0,
  };
  const changed = [];

  for (let i = 0; i < cold.length; i++) {
    const kw = cold[i];
    process.stdout.write(`[${String(i+1).padStart(3)}/${cold.length}] ${kw.keyword}\r`);
    let items;
    try { items = await scraper.search(kw.keyword); }
    catch (e) { summary.kwScrapeError++; console.error(`\n  scrape err "${kw.keyword}": ${e.message}`); continue; }
    if (items.length === 0) { summary.kwEmptyMercari++; continue; }

    let oldPass = 0, newPass = 0;
    const newlyPassed = []; // NEW でのみ通ったタイトル
    for (const it of items) {
      const okOld = filter.matchesKeyword(it.title, kw.keyword);
      const okNew = filter.matchesKeyword(it.title, kw.keyword, { tier: 'cold' });
      if (okOld) oldPass++;
      if (okNew) newPass++;
      if (okNew && !okOld) newlyPassed.push({ price: it.price, title: it.title });
    }

    if (oldPass !== newPass) {
      summary.kwChanged++;
      summary.totalDeltaMatched += (newPass - oldPass);
      if (newPass > oldPass) summary.kwIncreased++;
      else summary.kwDecreased++;
      if (oldPass === 0 && newPass > 0) summary.kwZeroToNonzero++;
      changed.push({ id: kw.id, kw: kw.keyword, oldPass, newPass, delta: newPass - oldPass, newlyPassed, raw: items.length });
    }
  }
  process.stdout.write('\n\n');

  // 差分ありキーワード一覧 (delta 降順)
  changed.sort((a, b) => b.delta - a.delta);
  console.log('=== 差分ありキーワード (NEW - OLD が非0) ===');
  console.log('id  | keyword                                | raw | old→new (Δ) | sample newly-passed');
  for (const c of changed) {
    const sample = c.newlyPassed.slice(0, 2).map(s => `¥${s.price} "${s.title.slice(0,40)}${s.title.length>40?'...':''}"`).join(' / ');
    const sign = c.delta > 0 ? '+' : '';
    console.log(
      String(c.id).padStart(3),
      '|', (c.kw + '                                        ').slice(0, 40),
      '|', String(c.raw).padStart(3),
      '|', String(c.oldPass).padStart(3), '→', String(c.newPass).padStart(3), `(${sign}${c.delta})`,
      '|', sample
    );
  }

  console.log('\n=== サマリ ===');
  console.log(`Cold 対象キーワード:      ${summary.kwTotal}`);
  console.log(`スクレイプエラー:         ${summary.kwScrapeError}`);
  console.log(`Mercari 0件返却 (対象外): ${summary.kwEmptyMercari}`);
  console.log(`OLD/NEW 通過数が変わる:   ${summary.kwChanged}`);
  console.log(`  うち NEW で増加:        ${summary.kwIncreased}`);
  console.log(`  うち NEW で減少:        ${summary.kwDecreased} (フレーズ一致が消えた稀ケース)`);
  console.log(`  うち 0件→非0件 (救済):  ${summary.kwZeroToNonzero}`);
  console.log(`合計通過タイトル増分:     ${summary.totalDeltaMatched}件`);
  console.log('');
  console.log('注意: 上記は matchesKeyword 通過数の変化のみ。');
  console.log('      実際の通知発火は LayerA (価格/経過時間/NG) と overstock 通知抑止を');
  console.log('      さらに通過する必要がある。実通知増は上記の一部にとどまる見込み。');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
