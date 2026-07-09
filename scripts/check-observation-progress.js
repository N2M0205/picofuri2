#!/usr/bin/env node
// 24時間観察の進捗チェック用スクリプト
// 使い方: node scripts/check-observation-progress.js
// 出力: 経過時間、通知件数の変化、error件数、24h経過判定

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_PATH = path.join(__dirname, '..', 'logs', 'observation_marker.json');
const OUT_LOG = '/home/picofuri2/picofuri2/logs/out.log';
const ERROR_LOG = '/home/picofuri2/picofuri2/logs/error.log';

if (!fs.existsSync(MARKER_PATH)) {
  console.error('marker not found:', MARKER_PATH);
  process.exit(1);
}

const marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf-8'));
const now = Math.floor(Date.now() / 1000);
const elapsed = now - marker.start_time_unix;
const elapsedH = (elapsed / 3600).toFixed(1);
const remaining = 86400 - elapsed;
const remainingH = (remaining / 3600).toFixed(1);
const passed24 = elapsed >= 86400;

// 現在時刻の out.log 行数
const outLines = fs.readFileSync(OUT_LOG, 'utf-8').split('\n').length;
const outDelta = outLines - marker.start_out_log_lines;

// 直近 100 行の通知件数 (最新スキャンの notified 値)
const lines = fs.readFileSync(OUT_LOG, 'utf-8').split('\n');
const scanLines = lines.filter(l => l.includes('スキャン完了'));
const latestNotify = scanLines.length > 0
  ? (() => {
      const last = scanLines[scanLines.length - 1];
      const m = last.match(/通知: (\d+)/);
      return m ? parseInt(m[1]) : null;
    })()
  : null;
const notifyDelta = latestNotify !== null ? latestNotify - marker.start_notify_count : null;

// 直近 errors (start時刻以降)
const errorLines = fs.readFileSync(ERROR_LOG, 'utf-8').split('\n');
const startDate = new Date(marker.start_time_iso);
const startTs = startDate.toISOString().replace(/T/, ' ').replace(/Z$/, '');
// ログの時刻は "YYYY-MM-DD HH:MM:SS:" 形式
const errorsAfterStart = errorLines.filter(l => {
  const m = l.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (!m) return false;
  const logDate = new Date(`${m[1]}T${m[2]}+09:00`);
  return logDate.getTime() / 1000 >= marker.start_time_unix;
}).length;

console.log('=== 観察進捗 ===');
console.log(`  開始時刻: ${marker.start_time_iso}`);
console.log(`  現在時刻: ${new Date().toISOString()}`);
console.log(`  経過: ${elapsedH}時間 (${elapsed}秒)`);
console.log(`  残り: ${remainingH}時間`);
console.log(`  24時間経過: ${passed24 ? '✅ YES' : 'まだ'}`);
console.log(`  out.log 増加: +${outDelta}行 (${marker.start_out_log_lines} → ${outLines})`);
console.log(`  通知件数: ${marker.start_notify_count} → ${latestNotify} (delta: ${notifyDelta > 0 ? '+' : ''}${notifyDelta})`);
console.log(`  error.log 新規行: ${errorsAfterStart}件`);

process.exit(passed24 ? 0 : 42); // exit code 42 = まだ、0 = 完了
