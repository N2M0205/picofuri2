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

### [2026-07-06 10:20〜10:29] Yahoo!フリマ 段階的再開の実地検証（feat/yahoo-partial-reenable）

- **種別**: ✅仮定して進行（技術選択）→ **拡大タイミングはビジネス判断としてオーナーへ**
- **内容**: 429解除確認済のYahoo!フリマ側に対し、選定8キーワードのみを対象とした allowlist方式で段階再開。3-5スキャン相当（実際は6スキャン、約6分観察）で 429再発なし・実データ正常返却を確認。
- **理由**: 「該当なしマーカー6候補」は429中に未検証、少数キーワードでの実地校正が必要。全77一括再開ではrate limit再誘発リスクがあるため。
- **影響範囲**: `src/services/ScrapingService.js`（allowlist ロジック追加）、`.env`（YAHOO_KEYWORD_ALLOWLIST 追加、YAHOO_SCRAPING_ENABLED を true に）。実装は環境変数のみで制御、Keyword.platforms 直接書換なし → 元に戻すのが容易。

#### 検証キーワード選定 (8件)

過去に確実にヒットしていた検証実績あり／通知件数上位で価格帯・除外語がクリーンなキーワードを選定。min=0 で誤ヒットしやすい（フラバン等）は今回対象外（429検証が目的、フィルタ精度は別タスク）。

| # | id | keyword | 選定理由 |
|---|----|---------|--------|
| 1 | 1 | トイラボ | 前回テスト検証実績、既知ヒット確定 |
| 2 | 69 | WrinkFade ハイカバー | OVERNIGHT TOP1、通知クリーン |
| 3 | 58 | プロキオン 60 | OVERNIGHT TOP2、通知クリーン |
| 4 | 46 | さかな暮らし | OVERNIGHT TOP4、実データ豊富 |
| 5 | 48 | チャップアップ | 除外語=サプリ,ビオルチア が有効、min>0 |
| 6 | 42 | スパルト T5 | 中位、min=7000 |
| 7 | 27 | スラヘル | 中位、min=1000、実データ量多い |
| 8 | 38 | セノッピー | TOP、除外語=チュアブル、min=1900 |

代替候補として当初挙げた `りそうのコーヒー` (id=21) は `platforms=["mercari"]` のみでYahoo対象外だったため `セノッピー` に差替え（Yahoo検証に使えないため）。

#### 実装フェーズで仮定した内容

- **仮定14**: 検証モードは環境変数 `YAHOO_KEYWORD_ALLOWLIST=<カンマ区切りキーワード名>` で管理。**理由**: (i) `Keyword.platforms` を77件書換すると復旧漏れリスクがある、(ii) env変更だけで on/off できる、(iii) 空文字/未設定なら絞込なし＝全キーワード対象という素直な仕様。**影響範囲**: `src/services/ScrapingService.js`。
- **仮定15**: allowlist の照合はキーワード**名**の完全一致（`Keyword.keyword` 文字列と env 各要素の trim 後比較）。**理由**: id は非直感的、名前ならログでも読める。**リスク**: 全角スペース／半角スペースの差異でマッチ失敗の可能性 → 実装時にログに `適用: 8/75件` を出して視覚検証で担保。**影響範囲**: 同上。
- **仮定16**: 検証結果ログを `[ScrapingService] YAHOO_KEYWORD_ALLOWLIST 適用: X/Y件に絞り込み (kw1, kw2, ...)` の形式で毎スキャン出力。**理由**: 検証中の設定確認と、拡大時の設定戻し漏れ検知の両方を兼ねる。**影響範囲**: 同上。

#### 検証結果（6スキャン、約6分）

| 指標 | 結果 |
|------|------|
| 429 再発 | **0件** ✓（error.log YahooScraper系メッセージ全期間0）|
| 商品セレクタタイムアウト | **0件** ✓ |
| 「該当なしマーカー」誤検出 | **確認できず**（全8kw中、実データ返却キーワードで正常抽出、0件返却kwは実際に該当なしの可能性・断定不能）|
| Yahoo 通知件数 | 21件（トイラボ 1 + スラヘル 12 + セノッピー 4 + プロキオン60 1 + キャップ抑制 165）|
| スキャン所要時間 | 17-27秒（従来77kw全timeout時 596秒、8kw実データ時 ~20秒）|
| 判定 | ✅ 429検出・サーキットブレーカー実装が本番稼働で誤動作なし。少数キーワードでの Yahoo アクセスは安定 |

---

### [2026-07-06 10:37〜10:39] Yahoo 20kw拡大 → 429再発 → 事前承認済み安全対応で停止

- **種別**: ✅仮定して進行（事前承認済み安全対応）→ 復旧方針は🛑ビジネス判断でオーナー確認
- **内容**: 8kw安定確認後、20kwに拡大 (10:37:33 反映) するも初回スキャンで即429検出 (10:38:11)、事前承認済み安全対応で `YAHOO_SCRAPING_ENABLED=false` に戻し (10:39:22 反映)。allowlist は復旧用に残置。
- **理由**: オーナー明示指示「429が再発した場合は、即座に再度 YAHOO_SCRAPING_ENABLED=false に戻したうえで報告してください（これは事前承認済みの安全対応として実行してよい）」に該当。
- **影響範囲**: `.env`（`YAHOO_SCRAPING_ENABLED=false`、`YAHOO_KEYWORD_ALLOWLIST=20件セット` は保持）

#### 20kw 選定基準の仮定（仮定17）
- **仮定17**: 追加12キーワードの選定は OVERNIGHT TOP25 の未収載品で min>0、深刻な誤ヒット指摘なし（パクパク酵母くん・WiQo・ホルモ プレミアム除外）。**理由**: 段階的再開の目的は「429検証」であり、フィルタ精度は別スコープ。**影響範囲**: `.env YAHOO_KEYWORD_ALLOWLIST`。

#### 429 検出時の安全対応の仮定（仮定18）
- **仮定18**: 429検出後 `.env` を書き戻して pm2 restart --update-env。**理由**: オーナー事前承認 (「事前承認済みの安全対応として実行してよい」)。**影響範囲**: `.env`、pm2 プロセス。**副次的判断**: allowlist の20件セットは削除せず残置し、`YAHOO_SCRAPING_ENABLED=true` に戻すだけで20kw運用に復帰可能な状態を維持。

#### オーナー決定内容（2026-07-06 に確定）
- **Q1: (C) アクセス頻度の見直し** を軸に対応（並列度の縮小か、リクエスト間 sleep 挿入）
- **Q2: (b) Task 2（cascading circuit breaker）先行実装** — 手動フォールバックの自動化
- **Q3: (a) feat/yahoo-partial-reenable のマージ** — allowlist 実装は 8kw運用にも必要のためマージ確定

---

### [2026-07-06 10:xx〜] Task 2 cascading circuit breaker + Task 4 頻度見直し（feat/yahoo-auto-fallback）

- **種別**: ✅仮定して進行（技術選択）
- **内容**: 429検出2回/30分でin-memoryフラグを立てて自動Yahoo停止、Telegram通知。並列度は 2→1 に落として burst 消滅。
- **理由**: 手動安全対応の自動化（safety net先行）と、実測から burst 検出仮説が濃厚なため concurrency=1 の効き目が期待できる。
- **影響範囲**: `src/services/ScrapingService.js`（in-memory フラグ、Telegram送信）、`.env`（`SCRAPING_CONCURRENCY_YAHOO` 変更）

#### 実装フェーズで仮定した内容

- **仮定19**: Task 4 の頻度見直しは **案2（並列度 1）を採用**（案1 の1-2秒sleepは採用せず）。**理由**: cron watch (1req/hour, 直列) は3日連続200成功、20kw × 並列2 (~0.5req/sec) は初回で429 → Yahoo は**バースト検出型 rate limit** の可能性が濃厚。並列度 1 = 同時アクセスゼロ = burstゼロ が最も効くと判断。実装は `.env` の `SCRAPING_CONCURRENCY_YAHOO` を 2 → 1 に変更するだけで最小。**影響範囲**: `.env`。**代替案**: 案2で不十分なら、後日 案1 (sleep追加) を上乗せする余地は残す。
- **仮定20**: 自動フォールバックの発動条件を「直近30分に **2回以上**」の 429 検出。**理由**: オーナー指示の閾値そのまま。単発 429 は一時的な負荷スパイクの可能性、2回目で明確な傾向と判断。**影響範囲**: `src/services/ScrapingService.js`。
- **仮定21**: 自動フォールバックのリセットは **プロセス再起動時のみ**（.envには触れない、in-memory 限定）。**理由**: オーナー明示指示「.envファイル自体の書き換えは行わない。プロセス再起動で自動リセットされる一時的な安全装置とする」。**影響範囲**: 復旧手順は pm2 restart --update-env が必要。
- **仮定22**: Telegram通知は `~/.claude-notify.env` を ScrapingService から直接読み込み、`axios.post` で送信（既存 `scripts/claude-notify-hook.sh` を bash からshell out するのではなく、Node内で直接）。**理由**: (i) 同一プロセス内で完結、(ii) shell out のオーバーヘッド回避、(iii) 依存(axios) は既にプロジェクトにあり。**影響範囲**: `src/services/ScrapingService.js` に fs / axios / os / path の require 追加。
- **仮定23**: 検証は 8kw + 並列度1 で 3-5スキャン、問題なければ 12kw に小拡大。**理由**: オーナー指示に沿った段階拡大。20kw への直接復帰は今回スコープ外。**影響範囲**: `.env YAHOO_KEYWORD_ALLOWLIST` の追加4件選定。

#### 検証結果（意図せずTask 3の実地テストになった）

| 指標 | 結果 |
|------|------|
| 8kw + 並列度1 の2スキャン | ❌ **429連続発生** (10:48:21 と 10:49:00) |
| Cascading breaker 発動 | ✅ 想定通り 2回目で in-memory フラグ true 化、Telegram 通知発火 |
| Task 3 実装の本番動作 | ✅ **意図せず本番実地テストになり、完全に想定通り機能** |
| Task 4 案2 (並列度1) 単独 | ❌ **8kwですら 429を防げず**、仮定19の効果予測は外れ |
| 事前承認済み安全対応 | ✅ .env を `YAHOO_SCRAPING_ENABLED=false` に戻し、二重防御化 |

#### 判明した新事実（仮定24 として追加記録）

- **仮定24**: 20kw 429 (10:38) → 8min待機 → 8kw+並列度1 で再開 (10:48) → 直ちに429再発。**推定**: 8分間の休止では Yahoo 側の rate limit ペナルティが解除されず、8kw + 並列度1 (0.2req/sec) でも我々の IP は既にブロック中/警戒中。cron watch (1req/hour) は 100%成功継続中なので、閾値は 「1req/h」と「0.2req/sec」の間のどこか、あるいは**キーワード多様性検出**（同一URLパターンだが検索クエリが違うと検知される）の可能性も。**影響範囲**: Task 4 案2 単独では不十分、追加対策（案1のsleep併用、大幅休止、キーワード分散スケジュール等）が必要。

---
