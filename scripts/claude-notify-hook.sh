#!/usr/bin/env bash
# Claude Code Stop/Notification フック → Telegram通知スクリプト
#
# 使い方（Claude Code hooks から自動呼び出し）:
#   scripts/claude-notify-hook.sh stop         # Stop フック時（応答完了）
#   scripts/claude-notify-hook.sh notification # Notification フック時（入力待ち）
#
# stdin: Claude Code から JSON ペイロード
#   { "transcript_path": "/path/to/session.jsonl", "session_id": "...", ... }
#
# 動作:
#   1. ~/.claude-notify.env から Bot Token / Chat ID を読み込み
#   2. transcript の最終 assistant テキストブロックから冒頭1〜2行を抽出
#   3. Telegram sendMessage エンドポイントに送信
#   4. エラー時も exit 0（フックがユーザ体験を阻害しないため）

set -uo pipefail

MODE="${1:-stop}"

# 資格情報読み込み
CRED_FILE="$HOME/.claude-notify.env"
if [ ! -f "$CRED_FILE" ]; then
  echo "[claude-notify-hook] warn: $CRED_FILE not found, skip" >&2
  exit 0
fi
# shellcheck source=/dev/null
source "$CRED_FILE"

if [ -z "${CLAUDE_NOTIFY_BOT_TOKEN:-}" ] || [ -z "${CLAUDE_NOTIFY_CHAT_ID:-}" ]; then
  echo "[claude-notify-hook] warn: credentials missing in $CRED_FILE, skip" >&2
  exit 0
fi

# stdin ペイロード読取（利用不可でも致命傷にしない）
PAYLOAD=$(cat 2>/dev/null || echo "{}")

# transcript_path 抽出（Node使用、jq依存を避ける）
TRANSCRIPT_PATH=$(node -e "
let s = '';
process.stdin.on('data', c => s += c);
process.stdin.on('end', () => {
  try { console.log(JSON.parse(s).transcript_path || ''); }
  catch { console.log(''); }
});
" <<< "$PAYLOAD" 2>/dev/null || echo "")

# 最終 assistant テキストの冒頭1〜2行抽出
SUMMARY=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  SUMMARY=$(TRANSCRIPT_PATH="$TRANSCRIPT_PATH" node -e "
    const fs = require('fs');
    const path = process.env.TRANSCRIPT_PATH;
    try {
      const raw = fs.readFileSync(path, 'utf-8').trim();
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.type === 'assistant' && msg.message && msg.message.role === 'assistant') {
            const content = msg.message.content || [];
            const textBlocks = content.filter(c => c && c.type === 'text' && c.text);
            if (textBlocks.length > 0) {
              const text = textBlocks[textBlocks.length - 1].text;
              const heads = text.split('\n').filter(l => l.trim()).slice(0, 2).join('\n');
              // Telegram 4096字制限、余裕を持って400字
              process.stdout.write(heads.slice(0, 400));
              break;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  " 2>/dev/null || echo "")
fi

# メッセージプレフィクス
case "$MODE" in
  stop)         PREFIX="✅ Claude Code 完了" ;;
  notification) PREFIX="⏸️ Claude Code 入力待ち" ;;
  *)            PREFIX="ℹ️ Claude Code ($MODE)" ;;
esac

if [ -n "$SUMMARY" ]; then
  MESSAGE="${PREFIX}
${SUMMARY}"
else
  # 要約取得不可時のフォールバック
  if [ "$MODE" = "notification" ]; then
    MESSAGE="${PREFIX}
（Claude Code が入力待ちで停止しています）"
  else
    MESSAGE="${PREFIX}
（要約取得不可）"
  fi
fi

# Telegram に送信（失敗しても exit 0）
curl -sS -m 10 "https://api.telegram.org/bot${CLAUDE_NOTIFY_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CLAUDE_NOTIFY_CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}" \
  > /dev/null 2>&1 || true

exit 0
