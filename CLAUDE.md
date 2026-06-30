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
