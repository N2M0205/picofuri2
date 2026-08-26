// PM2 ecosystem for cloudflared quick tunnel
// (2026-08-26 追加、feat/telegram-inventory-alert)
//
// picofuri2 本体とは独立した PM2 app として登録し、独立ライフサイクルで管理する。
// 既存 ecosystem.config.js (picofuri2 本体) には一切影響しない。
//
// 使用例:
//   pm2 start ecosystem.cloudflared.config.js
//   pm2 stop cloudflared-picofuri2
//   pm2 restart cloudflared-picofuri2
//   pm2 logs cloudflared-picofuri2
//
// systemd 経由での自動起動:
//   既存の pm2-picofuri2.service (systemd 登録済) が picofuri2 ユーザの pm2
//   daemon 全体を管理しているため、下記 pm2 start 実行後に
//     pm2 save
//   を叩けば、VPS 再起動時にこの app も自動復旧する。

module.exports = {
  apps: [{
    name: 'cloudflared-picofuri2',
    script: './scripts/cloudflared-tunnel-wrapper.js',
    cwd: '/home/picofuri2/picofuri2',
    env: {
      // wrapper が読む環境変数 (省略値は wrapper 内デフォルトに従う)
      TUNNEL_LOCAL_URL: 'http://localhost:3001',
      TUNNEL_ENV_KEY:   'PICOFURI_TUNNEL_URL',
      TUNNEL_ENV_PATH:  '/home/picofuri2/picofuri2/.env',
      CLOUDFLARED_BIN:  '/usr/local/bin/cloudflared',
    },
    max_memory_restart: '150M',
    restart_delay: 5000,
    // トンネル再起動時に PICOFURI_TUNNEL_URL が変わるため、picofuri2 本体は
    // 再起動しない。picofuri2 側は Telegram 送信直前に .env を都度読み直す
    // 実装 (InventoryAlertService.readEnvValue) で対応済み。
    error_file: './logs/cloudflared-error.log',
    out_file:   './logs/cloudflared-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
