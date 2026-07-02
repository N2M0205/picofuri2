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
