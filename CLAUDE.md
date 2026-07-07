# CLAUDE.md — ピコフリ2 プロジェクト定義書
> Claude Code セッション開始時に必ず読み込むこと

---

## プロジェクト概要

| 項目 | 内容 |
|------|------|
| プロジェクト名 | ピコフリ2（picofuri2） |
| 目的 | メルカリ・Yahoo!フリマで自社EC商品の転売出品を監視し、LINE通知する |
| 運用環境 | ConoHa Linux VPS / Ubuntu 24.04 |
| 実行ユーザー | picofuri2 |
| プロジェクトパス | /home/picofuri2/picofuri2/ |
| Node.js | v22.x（nvm管理） |
| プロセス管理 | PM2 |
| DB | SQLite（Sequelize、NODE_ENV=development） |
| ブランチ戦略 | main保護・必ずブランチを切る |

---

## 役割分担（最重要）

| 役割 | 担当 | 責任範囲 |
|------|------|---------|
| 設計担当 | Claude（チャット） | 方針決定・設計・レビュー・承認 |
| 実行担当 | Claude Code（このセッション） | コーディング・テスト・報告 |

**実行担当は設計担当の承認なしに設計変更・仕様変更を行わない。**
**「これでいいか」と思ったら、実装前に必ず確認を取ること。**

---

## 🔍 セッション開始時の棚卸し（新規セッション or 長い間隔後に実施）

以下を5-10分程度で実施し、結果をチャットに報告すること：
1. git log --oneline main -20 で直近コミット履歴を確認・報告
2. git branch -a で仕掛かり中ブランチを列挙・報告
3. 直近24-48時間のBACKLOG.md/ASSUMPTIONS-LOG追記を確認・報告
4. 「オーナーから送られたはずだが未着手に見える指示」があれば
   その旨を明示し、オーナーに確認を仰ぐ

---

## Gitルール（絶対厳守）

```
✅ 許可
  - 任意のファイル編集
  - feat/ fix/ refactor/ ブランチ作成
  - ブランチ内のcommit
  - git push origin <ブランチ名>

❌ 禁止（オーナー承認なし）
  - main ブランチへの直接編集・commit
  - git merge（承認後のみ）
  - git reset --hard（承認後のみ）
  - git push --force

🔁 問題発生時
  - git revert で即復旧（reset --hardは使わない）
```

### ブランチ命名規則

| 種別 | 形式 | 例 |
|------|------|-----|
| 新機能 | feat/説明 | feat/mercari-api-scraper |
| バグ修正 | fix/説明 | fix/yahoo-selector |
| リファクタ | refactor/説明 | refactor/scraping-service |

### マージ前の必須手順

```bash
git diff main  # 差分をオーナーに提示
# → オーナー承認後のみ merge 実行
```

---

## PM2ルール

| 操作 | 許可 |
|------|------|
| `pm2 restart picofuri2` | ✅ 自由に可 |
| `pm2 stop picofuri2` | ✅ 自由に可 |
| `pm2 logs picofuri2` | ✅ 自由に可 |
| `pm2 delete picofuri2` | ❌ オーナー承認後のみ |
| `pm2 start` | ✅ マージ後・オーナー指示後のみ |

**PM2再起動は必ずmerge完了後、オーナーの指示があってから行う。**

---

## ファイル操作ルール

- 全ファイルの編集は自由
- `.env`を変更する場合：変更前の値を必ず記録・報告してから変更する
- DB操作（migrate等）の前：バックアップを必ず取る
  ```bash
  cp /home/picofuri2/picofuri2/database.sqlite \
     /home/picofuri2/picofuri2/database.sqlite.bak_$(date +%Y%m%d_%H%M%S)
  ```
- ログや画面出力に`.env`の秘密情報（APIキー等）を絶対に含めない

---

## 実装の進め方

```
1. ヒアリング（目的・ゴール・制約を確認）
2. 提案（選択肢2〜3案を提示）
3. オーナー承認
4. ブランチ作成
5. 実装（1変更ずつ）
6. テスト・結果報告
7. git diff main を提示
8. オーナー承認 → merge → PM2再起動
```

**複数の変更を一気に入れない。問題の切り分けが困難になるため。**

---

## ⚠️ タスク実行の区切りルール(暴走防止)

- 1回の依頼に含まれるタスクが複数ある場合、最大3タスクごとに一度停止し、
  進捗を報告してオーナーの継続指示を待つこと
- 調査・探索系タスク（grep/find/ログ解析等の繰り返し）は、開始から15分相当の
  作業量を超えたら一度停止し、中間結果と残作業見積もりを報告すること
- 「完了の定義」が不明確なまま作業を続けない。不明確だと感じた時点で
  停止してオーナーに確認すること
- エラーが3回連続で解決しない場合、別のアプローチを自分で試み続けるのではなく、
  停止して状況を報告すること

---

## ⚠️ 判断領域の分類ルール（ビジネス判断 vs 技術選択）

以下の表に基づき、判断が必要になった際の対応を分岐すること。

| 領域 | 該当例 | 対応 |
|------|--------|------|
| ビジネス判断（要停止・確認） | 価格・利益計算の閾値や計算式、商品の対象/対象外判定基準（状態・賞味期限・評価等）、除外ロジックか単価計算かなどの方式選択、通知の出し方・優先度・階層のデフォルト値、キーワード・SKUのマッピング方針 | **作業を停止し、オーナーに確認すること** |
| 技術選択（進行してログ記録） | 変数名・関数名・ファイル構成、性能に影響しない実装アルゴリズムの選び方、ログの出力形式、テストの書き方 | 仮定して進めてよい。ただし logs/assumptions/ASSUMPTIONS-{YYYY-MM}.md に記録すること |

判断がどちらの領域か迷う場合は、ビジネス判断側として扱い、停止して確認すること。

すべての完了報告には「前提ログ」セクションを含め、当該タスクで
発生した停止確認・仮定進行の項目を列挙すること（0件の場合も「なし」と明記）。

---

## 📄 報告の使い分け（Google Docs vs チャット直接）

- 長文の実装結果・調査レポート（一晩稼働分析、複数ファイルにまたがる調査等）
  → scripts/report-to-docs.js で Docs に記載し、チャットには
  「Docsに記載済み」+ 要約2-3行のみを返す
- 短い確認質問（判断領域分類ルールに基づく停止確認、Q1/Q2形式の分岐選択）
  → 従来通りチャット/Telegramで直接やり取りする
- 中断・完走時の状態通知 → 既存のStop/Notificationフックが担当（変更不要）
- 判断に迷う場合は、まず短く報告してオーナーの反応を見てから
  詳細をDocsに書くかどうか決めてよい

---

## 報告フォーマット

### 実装完了時

| 項目 | 内容 |
|------|------|
| 完了した作業 | |
| 変更ファイル | |
| コミットハッシュ | |
| テスト結果 | |
| 次のステップ | |
| 懸念事項 | |

### エラー発生時

```
【原因】
【影響範囲】
【修正案A】メリット／デメリット
【修正案B】メリット／デメリット
【推奨】
```

---

## 禁止事項

- オーナー承認なしで main にマージしない
- テストなしで本番に適用しない
- `.env`の秘密情報をログ・コード・コミットに含めない
- 指示された箇所以外のロジックを無断で変更しない
- `NODE_ENV=production` を使わない（PostgreSQL接続エラーの原因になる）
- `git pull --rebase` を使わない（merge を使うこと）

---

## システム構成

```
/home/picofuri2/picofuri2/
├── src/
│   ├── scrapers/
│   │   ├── MercariApiScraper.js   ← メルカリ内部API（Puppeteer不使用）
│   │   └── YahooScraper.js        ← Yahoo!フリマ（Puppeteer）
│   ├── services/
│   │   ├── ScrapingService.js     ← スキャン統括
│   │   ├── CrossmallService.js    ← CROSSMALL API連携
│   │   └── NotificationService.js ← LINE通知
│   ├── models/
│   │   └── index.js               ← Sequelize + SQLite
│   └── index.js                   ← エントリーポイント
├── logs/
├── database.sqlite
├── .env
├── ecosystem.config.js            ← PM2設定
├── package.json
└── CLAUDE.md                      ← このファイル
```

---

## 技術的な重要知識

### メルカリ内部API

```
URL:    https://api.mercari.jp/v2/entities:search
方式:   POST / JSON
認証:   DPoP トークン（リクエストごとに生成、ログインなし）
ライブラリ: jose（npm）

DPoPの仕組み:
  - EC P-256 鍵ペアを起動時に1回生成
  - 毎リクエスト: 現在時刻 + ランダムUUID + 鍵で署名したJWT
  - htu（URL）とhtm（HTTPメソッド）をペイロードに含める

重要フィールド（レスポンス）:
  - items[].id         → 商品ID（"m"で始まる）
  - items[].name       → 商品名
  - items[].price      → 価格（文字列）
  - items[].created    → 出品日時（Unixタイムスタンプ・文字列）← 取得可能
  - items[].status     → "ITEM_STATUS_ON_SALE" or "ITEM_STATUS_SOLD_OUT"
  - items[].thumbnails → 画像URL配列

新着判定:
  - items[].created > 前回スキャン時刻 で判定可能
  - または DetectedItems テーブルの itemId で重複チェック
```

### Yahoo!フリマ

```
方式: Puppeteer + puppeteer-extra-plugin-stealth
URL:  https://paypayfleamarket.yahoo.co.jp/search/{{keyword}}
注意:
  - userDataDir はリクエストごとにユニーク生成・終了後削除
  - browser.close() は finally で必ず実行
  - listedAt は取得不可（null を許容）
  - --no-sandbox フラグ必須（Linux環境）
```

### CROSSMALL API

```
URL:    https://crossmall.jp/webapi2
署名:   全パラメータをキー名ソート → MD5 → 大文字
注意:
  - get_stock は商品名を返さない（get_item で別途取得）
  - order_number パラメータのみでページネーション可能
  - LinuxVPSのIPをCROSSMALL側でアクセス許可登録が必要
  - IPアドレス確認: curl ifconfig.me
```

### LINE通知

```
方式: Messaging API broadcast（全友達に送信）
エンドポイント: POST https://api.line.me/v2/bot/message/broadcast
```

---

## 環境変数一覧（.envの構成）

```env
NODE_ENV=development          # productionにしない
PORT=3001

SCRAPING_INTERVAL_SECONDS=60  # スキャン間隔（秒）
SCRAPING_CONCURRENCY_MERCARI=3
SCRAPING_CONCURRENCY_YAHOO=2

LINE_NOTIFY_ENABLED=true
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=

CROSSMALL_API_URL=https://crossmall.jp/webapi2
CROSSMALL_ACCOUNT=3663
CROSSMALL_API_KEY=

TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_ID=8656466812
```

---

## 監視キーワード一覧（初期登録済み）

| キーワード | プラットフォーム |
|-----------|----------------|
| トイラボ / ToyLaBO | mercari, yahoo_flea |
| オキシカット | mercari, yahoo_flea |
| risou no Coffee 30 | mercari, yahoo_flea |
| レムウェル 180 | mercari, yahoo_flea |
| WiQo | mercari, yahoo_flea |
| ラクトフェリン 93 | mercari のみ |
| 尿酸と脂肪のダブルバスター | mercari, yahoo_flea |
| アスハダ 30ml | mercari, yahoo_flea |
| ホルモ プレミアム | mercari, yahoo_flea |
| アルマダ 1000ml | mercari, yahoo_flea |
| 野草酵素 | mercari, yahoo_flea |
| デイリーワン | mercari, yahoo_flea |
| デオエース 40ml | yahoo_flea のみ |
| ワンデイ クレンズ | mercari, yahoo_flea |
| SENOPPY CHEWABLE | mercari, yahoo_flea |
| セノッピー チュアブル | mercari, yahoo_flea |
| 養宝珠 90粒 | mercari, yahoo_flea |
| ホワイトハンドセラム 20ml | mercari, yahoo_flea |
| ルックルック イヌリンプラス | mercari, yahoo_flea |
| りそうのコーヒー | mercari のみ |

---

## 既知の注意事項

- `NODE_ENV=production` は使わない（SQLite接続エラーの原因）
- Puppeteer on Linux: `--no-sandbox` `--disable-setuid-sandbox` フラグ必須
- PM2は `--update-env` フラグなしの restart では `.env` の変更を反映しない
  → `.env` 変更後は `pm2 restart picofuri2 --update-env`
- CROSSMALL `get_stock` は商品名を返さない。名前は `get_item` で取得
- メルカリAPIの `created` フィールドはUnixタイムスタンプ（文字列型）
  → `new Date(parseInt(item.created) * 1000)` で変換する

---

## ⚠️ 既知の潜在バグ（未発現・要注意）

### CrossmallService._generateSigning のソート順

現行実装は ASCII 昇順ソート（大文字が小文字より先）でパラメータをソートしている。
CROSSMALLサーバは大文字小文字を無視したソートで署名検証しているとみられる。

現在は本番で使用するパラメータキーがすべて小文字
（account, item_code, order_date_fr, order_number, sku_code, jan_code 等）のため
両ソート方式で結果が一致し、問題は顕在化していない。

**将来、大文字を含むパラメータ名（例: get_diff_stock の PascalCase候補）を
使う場合、署名が壊れる可能性がある。** その場合は `_generateSigning` のソートを
大文字小文字無視（`localeCompare` の `caseFirst` オプション、または両方を
`toLowerCase` してからソート）に変更すること。

発見日: 2026-07-01（get_diff_stock パラメータ探索調査時）

---

## ⚠️ 運用上の注意

### DetectedItem の全削除は禁止

`database.sqlite` の `DetectedItem` テーブルを全削除すると、次回スキャン時に
全登録商品（Yahoo 1000件超 + Mercari 数百件）が「新規」扱いになり、
Telegram に数百〜千件超の通知スパムが発生する。

DBリセットが必要な場合は必ずピコフリ2を停止してから実施し、
再起動後 `NOTIFY_CAP_PER_SCAN` により被害を最小限に抑えること。

---

## 📋 今後の課題（TODO）

### セット数量検出 + 価格乖離検知（優先度: 低）

**背景**

一晩稼働分析（`logs/analysis/OVERNIGHT-ANALYSIS-20260702.md`）で以下の誤ヒットパターンが判明：

- セット販売混入（パクパク酵母くん 12箱 ¥40,000、セノッピー 6袋 ¥15,999 等）
- 複合ヒット（ホルモ プレミアム：育毛剤 ¥4,000–¥19,500 とサプリ ¥1,280 が同キーワード）
- WiQo の複数SKU混在（4種の製品が同キーワードでヒット）

**方針（決定済み、実装は未着手）**

除外ではなく「**検出して単価計算する**」方向で対応する。

1. **A: セット数量検出**
   - タイトルから「N箱 / N袋 / N個 / N包」パターンを正規表現で検出
   - 検出時は `価格 ÷ 数量` で単価計算し、通常の1個商品と同じ利益計算ロジックに乗せる

2. **B: 価格乖離検知**
   - CROSSMALL直近販売価格に対し、フリマ出品価格（または A 適用後の単価）が
     著しく安い場合に警告
   - タイトルに数量が明記されない出品（例: 写真は2個だが説明文にのみ記載）は
     A では検出不可能なため、B による価格逸脱検知が実質的な安全網になる
   - 処理順序: ①タイトルから数量抽出 → ②セット単価計算（できれば）
     → ③その単価を B の価格乖離チェックにかける（数量抽出できなければ元の価格でチェック）

**未決定事項（実装着手前に確定が必要）**

- B の乖離判定閾値（例: 直近販売価格の何%未満で警告か）。高すぎる場合も見るか、安すぎるケースのみか
- 閾値到達時の扱い：⚠️警告ラベル付きで通知 vs 完全除外
- `sales28=0` 等で CROSSMALL 参考価格がないSKUの扱い（B をスキップしてそのまま通知でよいか）
- 適用範囲：77キーワード全体に一括適用 vs 段階的ロールアウト

**適用範囲（決定済み）**

77キーワード全体に適用する（キーワード非依存のロジックのため、
実装すれば自動的に全キーワードに効く）。

**着手条件**

階層化スキャン（Hot/Warm/Cold）実装を優先し、本タスクはその後に着手する。

追加日: 2026-07-02

---

## セッションログの保存

各作業セッション終了時に以下の形式でログファイルを保存すること：

```bash
# ファイル名例
/home/picofuri2/picofuri2/SESSION-LOG-YYYY-MM-DD.md
```

ログに含める内容：
- 完了した作業一覧
- 変更ファイルとコミットハッシュ
- 発見された事実・教訓
- 未完了タスク（優先度付き）
- PM2プロセス状態

---

## Linux ユーザー設定メモ

```bash
# picofuri2ユーザーで作成
# 作業は常に picofuri2 ユーザーで実施すること
su - picofuri2
cd ~/picofuri2

# nvm は picofuri2 ユーザーの ~/.bashrc に設定されている
source ~/.bashrc
node --version  # v22.x.x
```
