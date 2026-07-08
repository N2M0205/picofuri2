#!/usr/bin/env node
// Yahoo cascading breaker 発動履歴の確認スクリプト
//
// 目的: 過去N時間の 429 検出と breaker 発動を、複数ファイル・複数観点から
//       クロスチェックする。単一の grep コマンドに頼らず、見落としを防ぐ。
//
// 使い方:
//   node scripts/check-yahoo-breaker.js               # 過去24時間の全イベント
//   node scripts/check-yahoo-breaker.js --hours 48    # 過去48時間
//   node scripts/check-yahoo-breaker.js --since '2026-07-08 00:00'
//
// 出力:
//   - [YahooScraper] 429検出 の件数と時刻一覧
//   - 🚨 Yahoo自動停止 (breaker 発動) の件数と時刻
//   - Yahoo自動停止中 (継続) の期間
//   - Telegram 通知送信の成否 (エラーログの有無)
//   - 全体サマリ
//
// 実装ノート:
//   - fs.readFileSync で out.log / error.log を個別に読み、grep 複数ファイル指定
//     時の filename prefix 問題を回避
//   - 時刻フィルタは JS Date 比較 (文字列比較の順序依存を避ける)

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const OUT_LOG = path.join(LOG_DIR, 'out.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

function parseArgs() {
  const args = process.argv.slice(2);
  let hours = 24;
  let since = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hours' && args[i + 1]) hours = parseInt(args[i + 1], 10);
    else if (args[i] === '--since' && args[i + 1]) since = args[i + 1];
  }
  return { hours, since };
}

function parseTimestamp(line) {
  // ログ行の先頭 "YYYY-MM-DD HH:MM:SS" を Date に変換
  const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  // JST を UTC として扱う (絶対時刻比較の等価性)
  return new Date(`${m[1]}T${m[2]}+09:00`);
}

function readLogLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n').filter(Boolean);
}

function filterByTime(lines, sinceDate) {
  const out = [];
  for (const line of lines) {
    const ts = parseTimestamp(line);
    if (!ts) continue;
    if (ts >= sinceDate) out.push({ ts, line });
  }
  return out;
}

function main() {
  const { hours, since } = parseArgs();
  const sinceDate = since
    ? new Date(since.replace(' ', 'T') + '+09:00')
    : new Date(Date.now() - hours * 60 * 60 * 1000);

  console.log(`=== Yahoo breaker check (since ${sinceDate.toISOString()}) ===\n`);

  const outLines = readLogLines(OUT_LOG);
  const errLines = readLogLines(ERROR_LOG);
  console.log(`  out.log 総行数: ${outLines.length}`);
  console.log(`  error.log 総行数: ${errLines.length}`);

  // out と error から時刻フィルタ、両方を統合
  const allLines = [
    ...filterByTime(outLines, sinceDate).map(x => ({ ...x, source: 'out' })),
    ...filterByTime(errLines, sinceDate).map(x => ({ ...x, source: 'error' })),
  ];
  console.log(`  時刻フィルタ後: ${allLines.length}行\n`);

  // 429 検出
  const rate429 = allLines.filter(x => /\[YahooScraper\] 429検出/.test(x.line));
  console.log(`=== [YahooScraper] 429検出: ${rate429.length}件 ===`);
  for (const { ts, source, line } of rate429) {
    console.log(`  [${source}] ${ts.toISOString()} → ${line.slice(0, 100)}`);
  }
  console.log('');

  // 🚨 Yahoo自動停止 (breaker 発動)
  const fires = allLines.filter(x => /🚨 Yahoo自動停止/.test(x.line));
  console.log(`=== 🚨 Yahoo自動停止 (breaker 発動): ${fires.length}件 ===`);
  for (const { ts, source, line } of fires) {
    console.log(`  [${source}] ${ts.toISOString()} → ${line.slice(0, 100)}`);
  }
  console.log('');

  // Yahoo自動停止中 (継続、スキップメッセージ)
  const skips = allLines.filter(x => /Yahoo自動停止中/.test(x.line));
  console.log(`=== Yahoo自動停止中 (継続): ${skips.length}件 (最初と最後のみ表示) ===`);
  if (skips.length > 0) {
    console.log(`  最初: [${skips[0].source}] ${skips[0].ts.toISOString()}`);
    console.log(`  最後: [${skips[skips.length - 1].source}] ${skips[skips.length - 1].ts.toISOString()}`);
    const spanMs = skips[skips.length - 1].ts - skips[0].ts;
    const spanH = (spanMs / 3600000).toFixed(2);
    console.log(`  継続期間: ${spanH} 時間`);
  }
  console.log('');

  // Telegram 通知送信エラー
  const notifyErrors = allLines.filter(x => /Yahoo自動停止 Telegram通知エラー/.test(x.line));
  console.log(`=== Telegram 通知送信エラー: ${notifyErrors.length}件 ===`);
  for (const { ts, line } of notifyErrors) {
    console.log(`  ${ts.toISOString()} → ${line.slice(0, 150)}`);
  }
  if (notifyErrors.length === 0) {
    console.log('  (エラーなし = 送信は少なくとも例外を投げていない、実到達は Bot API 側で確認要)');
  }
  console.log('');

  // サマリ
  console.log('=== サマリ ===');
  console.log(`  429検出: ${rate429.length}件`);
  console.log(`  breaker 発動: ${fires.length}件`);
  console.log(`  自動停止継続ログ: ${skips.length}件`);
  console.log(`  Telegram 送信エラー: ${notifyErrors.length}件`);
  if (fires.length > 0) {
    console.log('  ⚠️ breaker が発動しています。Yahoo は自動停止状態の可能性。');
    console.log('     復旧: pm2 restart picofuri2 --update-env で in-memory 履歴クリア');
  } else if (rate429.length > 0) {
    console.log('  ⚠️ 429検出はあるが breaker 未発動 (直近30分に2件未満)');
  } else {
    console.log('  ✅ 429検出・breaker 発動ともになし、Yahoo は健全');
  }
}

main();
