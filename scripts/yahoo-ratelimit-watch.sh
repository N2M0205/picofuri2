#!/usr/bin/env bash
# Yahoo!フリマ rate limit 解除観察スクリプト
#
# 使い方（手動実行）:
#   bash scripts/yahoo-ratelimit-watch.sh
#
# 動作:
#   - Yahoo!フリマの検索エンドポイントに1回だけ curl でアクセス
#   - HTTPステータスコードと応答時間を logs/yahoo-ratelimit-watch.log に追記
#   - 200 系ステータスが返れば rate limit 解除の可能性、要検証
#
# cron登録はまだしない（手動でトリガーする運用、必要に応じてオーナーが cron化する）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$REPO_ROOT/logs/yahoo-ratelimit-watch.log"
mkdir -p "$(dirname "$LOG_FILE")"

# rate limit 対策: 実運用のUAと同じもの、負荷は極小（1req）
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
URL='https://paypayfleamarket.yahoo.co.jp/search/%E3%83%88%E3%82%A4%E3%83%A9%E3%83%9C'  # =トイラボ

TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S %Z")
RESULT=$(curl -sS -A "$UA" -o /dev/null -w "%{http_code} %{time_total}s %{size_download}bytes" --max-time 15 "$URL" 2>&1 || echo "curl-error")

echo "$TIMESTAMP $RESULT" >> "$LOG_FILE"
echo "recorded: $TIMESTAMP $RESULT"
echo "log file: $LOG_FILE"
