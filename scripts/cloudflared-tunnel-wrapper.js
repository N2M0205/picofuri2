#!/usr/bin/env node
// cloudflared quick tunnel の起動 + URL 抽出 + .env 自動更新のラッパー
// (2026-08-26 実装、feat/telegram-inventory-alert Chunk 3)
//
// 背景:
//   cloudflared tunnel --url http://localhost:3001 は起動毎に
//   ランダムサブドメイン (https://<random>.trycloudflare.com) を発行する。
//   Zero Trust アカウント未セットアップのため named tunnel は使えないので、
//   起動毎に発行される URL を .env の PICOFURI_TUNNEL_URL に自動反映する。
//
// 動作:
//   1. cloudflared プロセスを spawn (子プロセス、std{err,out} pipe)
//   2. stderr/stdout を tee (親プロセスに透過表示)
//   3. 出力から "https://<sub>.trycloudflare.com" 形式の URL を検出
//   4. 検出時 .env の PICOFURI_TUNNEL_URL 行を更新 (行が無ければ追加)
//   5. cloudflared が終了したら親プロセスも終了 (PM2 の autorestart に任せる)
//
// 実行例 (直接):
//   node scripts/cloudflared-tunnel-wrapper.js
// PM2 経由 (ecosystem.tunnel.config.js を参照):
//   pm2 start ecosystem.tunnel.config.js
//
// 環境変数:
//   TUNNEL_LOCAL_URL    (デフォルト: http://localhost:3001) 転送先
//   TUNNEL_ENV_KEY      (デフォルト: PICOFURI_TUNNEL_URL) 書き込む .env のキー名
//   TUNNEL_ENV_PATH     (デフォルト: <repo root>/.env) 書き込む .env のパス
//   CLOUDFLARED_BIN     (デフォルト: cloudflared) 実行するバイナリ

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOCAL_URL = process.env.TUNNEL_LOCAL_URL || 'http://localhost:3001';
const ENV_KEY   = process.env.TUNNEL_ENV_KEY   || 'PICOFURI_TUNNEL_URL';
const ENV_PATH  = process.env.TUNNEL_ENV_PATH  || path.join(__dirname, '..', '.env');
const BIN       = process.env.CLOUDFLARED_BIN  || 'cloudflared';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[cloudflared-wrapper ${ts}] ${msg}`);
}

/**
 * .env ファイルの ENV_KEY 行を newUrl に更新する (行が無ければ末尾追加)。
 * ロック取得はしない (同時書込みは想定しない、単一プロセス運用前提)。
 * 失敗時は WARN 出力のみ、tunnel 自体は継続。
 */
function updateEnvFile(newUrl) {
  try {
    let text = '';
    try { text = fs.readFileSync(ENV_PATH, 'utf-8'); }
    catch (e) {
      if (e.code === 'ENOENT') text = '';
      else throw e;
    }
    const re = new RegExp('^\\s*' + ENV_KEY + '=.*$', 'm');
    let updated;
    if (re.test(text)) {
      updated = text.replace(re, `${ENV_KEY}=${newUrl}`);
    } else {
      const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
      updated = `${text}${sep}${ENV_KEY}=${newUrl}\n`;
    }
    fs.writeFileSync(ENV_PATH, updated, { mode: 0o600 });
    log(`updated ${ENV_PATH}: ${ENV_KEY}=${newUrl}`);
  } catch (e) {
    console.error(`[cloudflared-wrapper] .env 更新失敗 (${ENV_PATH}): ${e.message}`);
  }
}

let currentUrl = null;

function processOutput(chunk) {
  const text = chunk.toString();
  process.stderr.write(text); // 透過表示

  const m = text.match(URL_PATTERN);
  if (m && m[0] !== currentUrl) {
    currentUrl = m[0];
    log(`URL 検出: ${currentUrl}`);
    updateEnvFile(currentUrl);
  }
}

log(`cloudflared 起動: ${BIN} tunnel --url ${LOCAL_URL}`);
log(`(env: ENV_KEY=${ENV_KEY}, ENV_PATH=${ENV_PATH})`);

const proc = spawn(BIN, ['tunnel', '--no-autoupdate', '--url', LOCAL_URL], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

proc.stdout.on('data', processOutput);
proc.stderr.on('data', processOutput);

proc.on('exit', (code, signal) => {
  log(`cloudflared exit code=${code} signal=${signal}`);
  process.exit(code || 1);
});

proc.on('error', (err) => {
  console.error(`[cloudflared-wrapper] spawn error: ${err.message}`);
  process.exit(1);
});

// SIGTERM/SIGINT を子プロセスに伝播 (PM2 stop 時の graceful shutdown)
process.on('SIGTERM', () => { log('SIGTERM 受信、cloudflared に伝播'); proc.kill('SIGTERM'); });
process.on('SIGINT',  () => { log('SIGINT 受信、cloudflared に伝播');  proc.kill('SIGINT');  });
