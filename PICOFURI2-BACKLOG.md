# ピコフリ2 バックログ

このファイルは未着手・進行中のタスクを一覧化したものです。
議論の詳細な経緯が必要な項目は、別途設計メモへのリンクを記載します。

## 🐛 バグ修正

- Yahooスクレイパー タイムアウト問題（timeout短縮・429検出・サーキットブレーカー・
  自動フォールバックまで実装済み。現在Yahoo段階再開の安全な構成を検証中）
- ホルモ プレミアム：複合ヒット（別カテゴリ商品が同キーワードに混在）
  - 育毛剤側 SKU 特定済: 2314-001596「ホルモ プレミアム ヘアー グロウ エッセンス 80ml」
    → id=10 の keyword を「ホルモ プレミアム 80ml」に絞り込み、crossmallItemCode を
    2314-001596 に統一 (2026-07-06 fix/horumo-premium-consolidation)
  - サプリ側 SKU: 未特定（¥1,280「HORMO ホルモ プレミアム栄養サプリメント」）
- WiQo：複数SKU混在（4製品が同キーワードに混在、SKU未特定）
- CROSSMALL itemCode誤り：デオエース40ml（2314-001070、CROSSMALLマスタ未登録）
- CROSSMALL itemCode未同期：プロキオン60（2314-000533）
- condition null時にNGワードフィルタが素通りする
- Yahooレア度カウント（420件表示等）の算出根拠が未検証
- NGワードフィルタが設定通りに機能しない（Win版でも「新品未使用のみ」設定済みでも
  「未使用に近い」等の中古品がヒットしていた）
- 販売コードと在庫コードが異なるSKUの個別対応（プロキオン等数件、
  販売2314-000533/在庫2314-001376の相違。現状は販売コードのまま登録しており
  在庫日数が判定不可になるケースが発生する。個別マッピング表の設計要）
- 重複通知: 同一Mercari出品を複数の overlapping キーワードが同スキャン内で拾い、
  Telegramに同じ item URL が複数回送信される可能性
  （2026-07-06 の12時間観察で 6件の (title, price) 重複を確認。
  DetectedItem.itemId の unique 制約で保存は 1件に絞られるが、
  [通知]ログは各キーワード分出力され、Telegramにも複数送信される疑い）。
  通知前の itemId 重複チェック追加を検討

## 🤔 設計判断待ち

- notified=false 恒久欠落の対処方針（リトライ/cap引上げ/階層化での自然解消/現状容認）
- キーワード↔SKU 多対多マッピング構造（表記ゆれ・バリエーション管理）
- 派生商品ワード辞書の統一設計（お試し/ミニ/セット等）
- レア度計算をフィルタ通過後データで再計算する設計
- CROSSMALL同期鮮度（何時間前の情報か）を通知に反映するか
- 通知キャップ20件の将来的な見直し基準
- get_diff_stock 未使用のまま運用継続でよいか（優先度低、パラメータ名不明のため保留）
- Yahoo検索が説明文まで検索対象になっている疑い（仕様起因の可能性、要検証）
- 損切り価格判定（値下げ販売による最終販売価格の誤認防止）
  - 案A（シンプル、採用予定）: 直近販売単価が過去平均より大きく下落（例30%以上）
    していたら「損切り疑い」フラグ
  - 欠品グループ設計とは切り離して実装（PICOFURI2-BUSINESS-RULES.md参照）
- 階層化スキャンでの実体単位の販売実績合算
  - n派生（末尾"n"の複数個買い派生コード）およびセット品の売上を
    ベースコード（CrossmallProduct.baseItemCode）に合算する集計設計
  - 現状は sales28 が itemCode 単位で集計されているため、実体1商品の
    実力を過小評価するケースがある（n派生でのみ売れているケース等）
  - 階層判定 (Hot/Warm/Cold) の閾値見直しと合わせて検討
  - **2026-07-10 案B（局所フォールバック）で暫定対応済み**
    （fix/n-suffix-fallback）: ScrapingService._resolveProduct が base の
    sales28=0 のとき n派生の sales/last* を merge して通知に渡す。
    stock は base 側を維持。CROSSMALL 同期側 (_updateProductStats) は無変更
  - 発覚時の影響件数: 226 アクティブキーワード中 57件 (25%) が該当していた
    （デオエース20ml/40ml, リンカルS, シミュート30g, ラクトフェリン93,
    さかな暮らし, アイムピンチ 60ml/30ml, & wolf 002 等）
  - 案A（恒久策・_updateProductStats を baseItemCode 集計に）は引き続き
    検討課題。決定が必要な論点:
    - n派生 CrossmallProduct の sales7/28 の扱い（0維持 or 合算値二重保持 or 廃止）
    - 集約後の isOverstock 判定（stockDaysが伸びて過剰在庫スキップが増える
      keyword が出る可能性。現時点でも案Bで発生: 例 さかな暮らし
      stock=21/s28=9 → stockDays=65 で LayerA スキップ対象になった）
    - 階層化スキャン Hot/Warm/Cold 判定閾値の見直しと同時決定
  - **2026-07-10 案Bマージ後の解釈確定**: n派生データ反映により
    overstock 判定が是正されるのは正しい挙動（データ欠損時代の誤通知が
    是正されただけ）。57件全体への影響は次回観察タスクで確認する
- CROSSMALL get_stock タイムアウトの retry ロジック
  （2026-07-06 の12時間観察で3件 / 約1580件、失敗率 0.19%。
  個別SKU障害で全体影響なしだが、retry 1回追加で解消可能か検討。
  現状: 通信エラーはスキップされて次スキャンで再取得の運用）
- Yahoo breaker 発動時の Telegram 通知の到達確実化
  （2026-07-08 の 429 見落とし事故を受けて、check-yahoo-breaker.js に
  よる棚卸し確認で当面運用するが、以下の追加施策を将来検討）
  - 案A: 発動 30 分後に自動リマインダーを再送 (同じ Bot から複数回通知)
  - 案B: picofuri2_bot (仕入通知用 Bot) にも投げて二重化
    (通知系統を跨ぐことで見落としリスクを下げる)
  - 案C: チャットのピン留め通知に昇格
    (Telegram API の pinChatMessage 等の利用)
  - いずれもコード変更を伴い、ユーザー通知の粒度・優先度の設計判断が必要
- キーワード短縮 (Task 3-b) で「有効トークンが単一の汎用英単語のみ」に
  劣化するケースの再発防止（2026-07-10、id=31「& wolf」参考ラベル多発の
  原因調査を受けて。暫定は id=31 を「& wolf 002」に個別復元済み）
  - 背景: `FilterService.matchesKeyword` の normalize 正規表現
    `/[^\w぀-ヿ一-鿿　-〿 ]/g` が `&` を空白化するため、「& wolf」は
    有効トークン `wolf` 1個に劣化。通知 6.9件/日→91.0件/日 (13.2倍)、
    91.4% が無関係商品（Jack Wolfskin, WOLF&RITA, Wolfgang 等）となった
  - 案2 (normalize修正): `&` を保護 or `and` に置換
    - 影響範囲: 全77キーワードのフィルタ挙動が変わる。短縮ロジックとの
      相互作用も再検証が必要
  - 案3 (短縮ロジック側): shortening 実適用スクリプトに STOP_WORDS 相当の
    「単一残存が危険な汎用英単語」ブロックリストを追加
    - 例: wolf, coffee, oil, plus, gold, silver, sun 等
    - 影響範囲: 短縮スクリプトのみ。ただし既存の 2tok 短縮 81件を
      同じ観点で見直す作業がセットで必要
  - 決定事項: Task 5 (24時間観察、2026-07-10 15:22完了見込み) 完了後に
    案2/案3 をまとめて検討する
- **itemId race attribution 問題 (対象別 SKU 群の残存ペア)**
  - 2026-08-11 案A opt-out (14 kw) + id=189 個別除外 4 語で主要案件は緩和済み。
    以下 5 ペアが「別 SKU なのに同一 itemId で race attribution」される残存問題:
    - id=68 「クレ ブラック」 × id=221 「クレムドアン ブラック 300g」 (68件/回)
    - id=141 「N organic Vie ローション」 × id=189 「Ｎ organic」 (54件/回)
    - id=209 「N organic Plenum」 × id=189 「Ｎ organic」 (74件/回)
    - id=39 「プルースト クリーム」 × id=201 「プルーストクリーム2.0 30ｇ」 (33件/回)
    - id=50 「ペプチア」 × id=206 「ペプチア 180粒」 (29件/回)
  - 現状の攻撃面:
    - DetectedItem.itemId は UNIQUE で行は 1 件だけ作成される (二重通知なし)
    - しかし race 勝者 keyword の crossmallItemCode で利益計算されるため、
      通知の利益率・在庫日数が本来の SKU と異なる
    - 通知のタイトル・価格は正しいので現場運用上の誤発注リスクは限定的
  - 実装検討 (2026-08-11 owner に提示、今回は範囲外):
    - 案 P-1 (一致精度スコア方式): matchesKeyword を pass/fail でなく token 一致数
      等のスコア返しに変更。race で勝った kw ではなく最高スコアの kw を選ぶ。
      _processItems の並列モデル変更が必要、実装大
    - 案 P-2 (SKU 単位 attribution テーブル): KeywordItemCandidate(itemId,
      keywordId, matchScore) を先に集めてからスキャン後に最高スコアで
      DetectedItem 作成。スキーマ変更 + 大規模ロジック改修
    - 案 P-3 (誤マッチ元の個別除外強化): 広範キーワード (id=189 等) に
      excludeKeywords を追加していく。実装小、keyword ごとの運用コスト増。
      本セッションでは id=189 に Owen/Unbranded/Grown/Tee を追加済み
    - 案 P-4 (opt-out リスト拡張): 上記 5 ペアの片方 (id=68/141/209/39/50 等) を
      opt-out に追加。短期緩和、根治にはならない
  - 決定事項: 案 P-1〜P-4 は今回スコープ外。次フェーズで方式決定 →
    実装検討する。当面は attribution 誤差を許容する運用
- テスト分離の根本対策 (2026-08-26 DetectedItems 消失インシデントを踏まえ)
  - 現状 (feat/telegram-inventory-alert): SKIP_DB_ALTER env + production
    プロセス自動検出の 2 段防御で「テスト時に本番 DB へ sync/alter しない」
    ことを保証。しかし本番 DB ファイルを読み取り目的でも共用しているため、
    テストが CrossmallSale 等に大量書き込みするとテスト後の削除ミスで
    本番データを汚染しうるリスクは残る (今回 test-inventory-alert-integration.js
    は synthetic itemCode 使用+teardown で削除しているが、規約依存)
  - 案C (根本対策): DATABASE_PATH env で DB ファイルパスを完全 override 可能に
    - 現行 src/models/index.js: `storage: path.join(__dirname, '../../database.sqlite')` を
      `process.env.DATABASE_PATH || <default>` へ
    - テストスクリプトは先頭で `process.env.DATABASE_PATH = '/tmp/test.sqlite'` 設定
    - synthetic データを毎回 setup + teardown で完全隔離、本番 DB 一切不参照
  - 影響範囲: models/index.js 1 行変更 + テストスクリプト全部の書き換え +
    integration test の synthetic データ生成ロジック拡充 (Keyword/CrossmallProduct/
    CrossmallSale を synthesized で用意する必要あり)
  - 判断保留: 今回スコープ超え。案A+B で当面の安全性は担保できているため、
    別途タスクとして検討

## ✨ 機能追加

- **OR構文（キーワード内バリエーション指定、Phase 1・案A）**
  - 2026-07-14 設計承認済み、実装着手は Yahoo 再開判断 (canary 3連続200 確定) 後
  - 仕様: `Keyword.keyword` に `｜` (全角) または `|` (半角) 区切りで
    バリアントを列挙可 (例: `トイラボ｜ToyLaBO`)。DBスキーマ変更なし
  - 実装:
    1. `FilterService.matchesKeyword` に OR 分岐追加 (~7行)、
       各バリアントで既存 `_matchesKeywordSingle` を `.some()` OR 判定
    2. Task 3-b 短縮スクリプト (`apply-keyword-shortening-*.js`) の
       tokenize に `｜` split 前処理を追加 (~5行)
    3. `test-matches-keyword.js` に OR ケースを追加
  - 検索 API 側: **アプローチ (b) を採用** = search は先頭バリアントのみ、
    filter で全バリアント OR 判定。**Yahoo 追加リクエストなし**、案Zと独立
  - 遡及適用候補: トイラボ/ToyLaBO・セノッピー チュアブル/SENOPPY CHEWABLE・
    ルックルック イヌリン系・nico/ニコ 石鹸・バルクス/VALX・デイリーワン系
    (6組)。実装後にオーナー承認で段階適用
  - 将来 Phase 2: Mercari のみでアプローチ (a) (バリアント毎に個別 API 呼び
    出し + deduplicate) を検討、Yahoo は Phase 2 対象外
- **階層化スキャン Hot/Warm/Cold/欠品中**（設計確定済み・最優先の本命、
  PICOFURI2-BUSINESS-RULES.md 参照。Yahoo構成確定後に実装着手予定）
- 全商品登録150SKU化（現在77件、残り約73件）
- セット数量検出＋価格乖離検知（PICOFURI2-BUSINESS-RULES.md セクション2参照、
  優先度低・未着手）
  - 併せて判断すべき登録保留 8件（バリエーション表記・セット数量絡み）:
    - 2314-000829n sales28=25「訳アリ セノッピー」
    - 2314-001270n sales28=15「ドクターズチョイス ファンガクリーム 57g」
    - 2314-000815n sales28=10「ナノカルファミリー プラス30包 ミドリ」
    - 2314-000739n sales28= 7「セノッピー パインマンゴー味 30粒 1袋」
    - 2314-001457n sales28= 4「ドクターワンデル プラス Dr.WANDEL + 30g」
    - 2314-0001091n sales28= 3「デオエースEXプラス 30g」
    - 2314-001843n sales28= 3「neco-ri かつお味 10包」
    - 2314-001262n sales28= 2「ナノカルファミリー 30包」
- 判定ラベルのDB記録（judgementLabel）
- sales14 集計ロジック実装（優先度低・実害なし）
- サブエージェント常駐化の検討（general-purposeのagentId継続機能を応用し、
  Yahoo watch等の定期監視を別セッション間で継続させる仕組み。今回の
  導入テストで存在が確認された、優先度低・将来検討）
- AI自動商品選定（長期ビジョン、全商品からAIが監視対象を自動選定）
- 仕入推奨の完全自動化（長期ビジョン、「通知が来たら買うだけ」を目指す）
- 商用サービス化（長期ビジョン）

## ⏸ 保留中指示

AGENT-OPERATIONS-TEMPLATE.md §4「指示文のライフサイクル管理」に基づく、
設計担当が作成したが意図的に送信していない指示文の記録カテゴリ。

（現時点で保留中の指示なし）

## 📋 オーナー宿題

- デオエース40ml 正しいitemCode確認（CROSSMALL管理画面）
- プロキオン60 正しいitemCode確認（CROSSMALL管理画面）
- ホルモ プレミアム SKU特定（育毛剤/サプリどちらが対象か）
- WiQo SKU特定（4製品のどれが対象か）
- GitHub PAT revoke実施確認（旧トークン）
- id=202のCROSSMALL商品名確認・修正（管理画面でitem_code=2314-001935の
  正しい商品名を確認し、判明次第Keywordテーブルを手動更新する）
  - 2026-07-07 判明: CROSSMALL master 側で item_name フィールドに itemCode
    (2314-001935) がそのまま格納されているデータ不整合。当システムでは修正不可

## ⏳ 進行中（時間経過待ち）

- Yahoo!フリマ: 7kw allowlist + 階層化スキャンで安定運用確立済み
  （2026-07-08時点、24時間429ゼロ・通知シェア33%を確認）。
  20kw以上への拡大はCold tier分散対策とセットで別途検討（✨機能追加カテゴリ参照）
