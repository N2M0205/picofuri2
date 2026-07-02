# 前提ログ 2026年7月

このファイルは、実装中に発生した「オーナー確認が必要な判断」「仮定して進めた判断」の
記録です。月次でローテーションします（前月分は logs/assumptions/ に別ファイルとしてアーカイブ）。

## 記載ルール
各エントリは以下の形式:

### [YYYY-MM-DD HH:MM] セッション概要
- **種別**: 🛑確認待ち / ✅仮定して進行
- **内容**: 何を判断/仮定したか
- **理由**: なぜその判断/仮定に至ったか
- **影響範囲**: 関連するファイル・機能

---

### [2026-07-02 19:00〜19:22] Yahooタイムアウト修正調査 → 429発覚 → D案採用

- **種別**: 🛑確認待ち（発覚後、オーナー判断でD案に切替）
- **内容**: 元スペック「timeout短縮＋該当なし早期判定」の前提となる0件ヒットページを Puppeteer 調査中、5テストキーワード（ダミー3件＋既知ヒット2件）**すべてで同一の HTTP 429 rate limit ページ**が返り、原因が Yahoo!フリマ側の IP アクセス制限であると判明。作業を停止してオーナー報告 → **D案（実装は元スペック通り＋Yahooスキャン一時停止フラグ、cron解除観察）** を採用。
- **理由**: 91.7%タイムアウト率の根本原因は「該当なしページの15秒待ち」ではなく「rate limit ページの15秒待ち」だった。元スペック(A)単独では「速く諦める」効果はあってもヒット率は改善しないため、ビジネス判断領域として停止・確認した。
- **影響範囲**: `feat/yahoo-timeout-fix` ブランチ全体、`src/services/ScrapingService.js`、`src/scrapers/YahooScraper.js`、`.env` (`YAHOO_SCRAPING_ENABLED` 新設)、`scripts/yahoo-ratelimit-watch.sh` (新規)

#### 調査時に仮定した内容（2件、事後記録）

- **仮定1**: 一時調査スクリプト `scripts/investigate-yahoo-noresult.js` を `scripts/` 配下に配置。**理由**: 既存の migrate-win-keywords.js と同ディレクトリで一貫性を優先。**結果**: 429発覚により未commit・作業完了後削除済。
- **仮定2**: 0件検索テスト用にダミー文字列を3種（英字ランダム / 日本語混合 / 混合）実行。**理由**: 0件を確実に引くための冗長化。**結果**: 5リクエスト全て 429（Yahoo!フリマへの追加負荷は微増、rate limit page が即返るため制限悪化への寄与は限定的と評価）。

#### 実装フェーズで仮定した内容（技術選択）

- **仮定3**: `YahooRateLimitError` を `YahooScraper.js` 内で定義し `module.exports.YahooRateLimitError` として名前付きexport、ScrapingService側は `err.name === 'YahooRateLimitError'` で判定。**理由**: 循環require回避と、instanceof より name比較の方がテスト・デバッグしやすい。**影響範囲**: `src/scrapers/YahooScraper.js`, `src/services/ScrapingService.js`。
- **仮定4**: `YAHOO_SCRAPING_ENABLED` のデフォルト値は "true" 相当（`process.env.YAHOO_SCRAPING_ENABLED !== 'false'`）。**理由**: 既存動作を破壊しないため（env未設定の他環境で有効のまま）。**影響範囲**: `src/services/ScrapingService.js`。
- **仮定5**: 「該当なし」早期判定のマーカー文字列を6候補（`該当する商品が見つかりませんでした` 等）で網羅。**理由**: 429中で実ページが検証できないため、日本語系ECサイトで一般的な文言を暫定採用。**リスク**: 誤検出で本来ヒットする検索を0件判定する可能性あり。**回避策**: rate limit 解除後の実測で必要ならセレクタ調整予定。
- **仮定6**: 監視スクリプトのテスト用URLに `トイラボ`（既知ヒットキーワード）を使用。**理由**: 200 が返るようになった時点でヒットが取れる状態と直接判定できる。**影響範囲**: `scripts/yahoo-ratelimit-watch.sh`。

---

### [2026-07-02 19:30〜19:35] Claude Code Stop/Notification フック実装（feat/claude-code-notify-hook）

- **種別**: ✅仮定して進行（技術選択のため）
- **内容**: aicham_dev_bot 経由で Claude Code のStop/Notificationイベントを Telegram 通知する仕組みを実装。トークン保管場所・スクリプト構造・設定ファイル配置の技術選択をまとめて仮定。
- **理由**: いずれもファイル配置・変数名・実装アルゴリズム選択に該当し、判断領域分類ルールにおいて技術選択領域と判定。
- **影響範囲**: `~/.claude-notify.env`（プロジェクト外・untracked）、`scripts/claude-notify-hook.sh`（新規・tracked）、`.claude/settings.json`（新規・tracked、プロジェクトレベル）

#### 実装フェーズで仮定した内容

- **仮定7**: 資格情報 (`CLAUDE_NOTIFY_BOT_TOKEN` / `CLAUDE_NOTIFY_CHAT_ID`) を `~/.claude-notify.env`（`$HOME` 直下、chmod 600、picofuri2 リポジトリ外）に保存。**理由**: (i) picofuri2 アプリの `.env` と混在させないというオーナー指示、(ii) リポジトリ外に置くことで git 履歴混入リスクを構造的に排除、(iii) `source` で bash からロード可能。**影響範囲**: `~/.claude-notify.env`（このVPSのみ、他環境では要再作成）。
- **仮定8**: フック設定を **プロジェクトレベル** `/home/picofuri2/picofuri2/.claude/settings.json` に配置（ユーザーレベル `~/.claude/settings.json` ではなく）。**理由**: (i) 設定をリポジトリで版管理できる、(ii) `~/.claude/settings.json` は他のユーザー全般設定と混じらせない、(iii) picofuri2 の cwd 配下で Claude Code を起動している運用パターンに合致。**影響範囲**: `.claude/settings.json`（新規、tracked）。**リスク**: cwd が picofuri2 外だとフックが発火しない → 現状 VPS上の Claude Code 利用は本プロジェクトのみのため実害なし。
- **仮定9**: フックスクリプトを単一ファイル `scripts/claude-notify-hook.sh` にして第一引数（`stop`/`notification`）で分岐。**理由**: 共通処理（資格情報読込・要約抽出・curl送信）が多く、DRY の観点で分割よりまとまりが良い。**影響範囲**: `scripts/claude-notify-hook.sh`。
- **仮定10**: transcript の要約抽出に Node.js を使用（jq ではなく）。**理由**: (i) Node.js は既にプロジェクト依存、(ii) JSONL の逆順走査＋テキストブロックフィルタが Node のほうがコード量少・可読性高、(iii) jq 導入不要。**影響範囲**: `scripts/claude-notify-hook.sh`。
- **仮定11**: 要約は「最終 assistant メッセージの text ブロックのうち最後のもの、空行を除く先頭2行、400字上限」で抽出。**理由**: 私の応答は最初に結論・要約を書く傾向があり、冒頭2行で概要が読める。400字上限は Telegram 4096字制限に対して余裕を持たせた値。**影響範囲**: 通知メッセージ本文。
- **仮定12**: フックは失敗しても `exit 0`（Claude Code の応答完了/入力待ちを阻害しない）。**理由**: Telegram側障害・ネットワーク断で Claude Code の動作自体が止まると本末転倒。**影響範囲**: `scripts/claude-notify-hook.sh` の全体エラーハンドリング。
- **仮定13**: 200検知時の Telegram 通知（watch script との共通化）は今回は含めない。**理由**: オーナー指示「無理に共通化しなくてもよい」に沿って別タスク化。認証情報は同じ `~/.claude-notify.env` を後日 source して統合可能な状態は残してある。**影響範囲**: `scripts/yahoo-ratelimit-watch.sh` (変更なし)。

---
