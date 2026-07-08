#!/usr/bin/env node
// 新規追加 157件 (id>77) のキーワード短縮案を機械的に生成する dry-run スクリプト
//
// 方針:
//   - CROSSMALL カタログ名 (現行キーワード) を「先頭3トークンまで」に短縮
//     ※ 半角スペース・全角スペース (　) 両方を token 区切りとして扱う
//     ※ 元が 1-3 tokens ならそのまま (短縮しても同一)
//   - フラグ:
//     A. 「既存キーワード (id<=77 または id>77 で若い id) と重複」 → 統合候補
//     B. 「短縮後 1 token のみ (ブランド名だけになるリスク)」 → 要手動判断
//     C. 「短縮なし (元が既に 1-3 tokens)」 → そのまま自動適用可
//     D. 「上記いずれもなし (安全な短縮)」 → そのまま自動適用可
//
// DB 書き込みは一切行わない (dry-run 専用)。

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword } = require('../src/models');

// 2026-07-07: 容量表記(50ml, 100g等)の消失を防ぐため 3 → 4 に変更
const KEEP_TOKENS = 4;

function tokenize(s) {
  // 全角スペース (　U+3000) と半角スペースの run を分離、空要素除去
  return s.split(/[\s　]+/).filter(Boolean);
}

function shorten(keyword, n = KEEP_TOKENS) {
  const tokens = tokenize(keyword);
  return tokens.slice(0, n).join(' ');
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  // 全 Keyword を id 昇順で取得
  const all = await Keyword.findAll({ order: [['id', 'ASC']], attributes: ['id', 'keyword'], raw: true });
  const seeds = all.filter(k => k.id <= 77);
  const news = all.filter(k => k.id > 77);
  const existingSet = new Set(seeds.map(k => k.keyword)); // seed そのままの keyword 文字列
  const seedById = new Map(seeds.map(k => [k.id, k.keyword]));

  console.log('=== 短縮 dry-run: 対象 ' + news.length + '件 (id>77) ===');
  console.log('  KEEP_TOKENS =', KEEP_TOKENS);
  console.log('');

  const results = [];
  const seenShortForms = new Map(); // 短縮案 → 最初の id

  for (const kw of news) {
    const tokens = tokenize(kw.keyword);
    const short = shorten(kw.keyword, KEEP_TOKENS);
    const shortTokens = tokenize(short);

    const flags = [];
    // A. 既存 seed keyword と完全一致
    if (existingSet.has(short)) flags.push('A:seed一致');
    // A2. 既存の他の新規 keyword (先に処理した若い id) と重複
    if (seenShortForms.has(short) && seenShortForms.get(short) !== kw.id) {
      flags.push(`A2:id=${seenShortForms.get(short)}と重複`);
    } else {
      seenShortForms.set(short, kw.id);
    }
    // B. 短縮後 1 token のみ
    if (shortTokens.length === 1) flags.push('B:1token化');
    // C. 短縮なし (元が既に短い)
    const noChange = short === kw.keyword;
    if (noChange) flags.push('C:短縮なし');

    results.push({
      id: kw.id,
      original: kw.keyword,
      short,
      origLen: kw.keyword.length,
      shortLen: short.length,
      origTokens: tokens.length,
      shortTokens: shortTokens.length,
      flags,
    });
  }

  // 分類集計
  const catA = results.filter(r => r.flags.some(f => f.startsWith('A')));
  const catB = results.filter(r => r.flags.some(f => f.startsWith('B')) && !r.flags.some(f => f.startsWith('A')));
  const catC = results.filter(r => r.flags.some(f => f.startsWith('C')) && !r.flags.some(f => f.startsWith('A') || f.startsWith('B')));
  const catD = results.filter(r => r.flags.length === 0);

  console.log('=== 分類集計 ===');
  console.log('  A. 既存 seed / 他の新規kw と重複 (統合候補):', catA.length + '件');
  console.log('  B. 短縮後1トークン化 (要手動判断):        ', catB.length + '件');
  console.log('  C. 短縮不要 (元が既に≤3 tokens):          ', catC.length + '件');
  console.log('  D. 安全な短縮 (フラグなし):                ', catD.length + '件');
  console.log('  ────────────────────────────────');
  console.log('  合計:', results.length + '件');
  console.log('');

  console.log('=== A. 重複 (統合候補) 一覧 (' + catA.length + '件) ===');
  for (const r of catA) {
    console.log('  id=' + String(r.id).padStart(3) + ' 【' + r.flags.join('|') + '】');
    console.log('    元 : ' + r.original);
    console.log('    短 : ' + r.short);
  }
  console.log('');

  console.log('=== B. 短縮後1トークン化 一覧 (' + catB.length + '件) ===');
  for (const r of catB) {
    console.log('  id=' + String(r.id).padStart(3) + ' orig=' + r.origTokens + 'tok/' + r.origLen + 'ch → short=1tok/' + r.shortLen + 'ch');
    console.log('    元 : ' + r.original);
    console.log('    短 : ' + r.short);
  }
  console.log('');

  console.log('=== C. 短縮不要 一覧 (' + catC.length + '件) ===');
  for (const r of catC) {
    console.log('  id=' + String(r.id).padStart(3) + ' (' + r.origTokens + 'tok/' + r.origLen + 'ch): ' + r.original);
  }
  console.log('');

  console.log('=== D. 安全な短縮 一覧 (' + catD.length + '件) ===');
  for (const r of catD) {
    console.log('  id=' + String(r.id).padStart(3) + ' orig=' + r.origTokens + 'tok/' + r.origLen + 'ch → short=' + r.shortTokens + 'tok/' + r.shortLen + 'ch');
    console.log('    元 : ' + r.original);
    console.log('    短 : ' + r.short);
  }
  console.log('');

  console.log('=== サマリ ===');
  console.log('  新規 157件のうち、そのまま自動適用してよいのは:', catD.length + '件 (' + Math.round(catD.length / results.length * 100) + '%)');
  console.log('  手動判断が必要:', (catA.length + catB.length) + '件');
  console.log('    - 重複統合 (case A):', catA.length + '件');
  console.log('    - 1トークン化リスク (case B):', catB.length + '件');
  console.log('  短縮不要 (現状のまま):', catC.length + '件');

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
