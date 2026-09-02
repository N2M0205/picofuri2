# ADR: 出品者評価・賞味期限・商品状態 3 フィルタの実装判断

- **日付**: 2026-09-02
- **ステータス**: 承認済 (partial: 商品状態 Mercari のみ実装、他は保留)
- **ブランチ**: feat/mercari-item-condition-filter
- **関連レポート**:
  - bc-design-vs-implementation-audit-report-20260902.txt
  - three-filters-feasibility-report-20260902.txt

## 1. 背景

Phase1 STEP1-4 (commit `1874589`, 2026-06-30) で以下 3 項目が「LayerA フィルタで
除外する」設計として仕様書に含まれたが、`FilterService.check()` の実装では
**一度も実装されなかった**:

| 項目 | 予定閾値 | 残存痕跡 |
|-----|---------|---------|
| 出品者評価 | 90% 未満 → NG | `DetectedItem.sellerRating` カラム (未 populate) |
| 賞味期限 | 5 ヶ月未満 → NG | `src/config/layerA.json:4 "layer_a_min_expiry_months": 5` (未参照) |
| 商品状態 | 「新品、未使用」以外 → NG | (痕跡なし。ngWords.js に状態語句 title 除外あるのみ) |

`FilterService.check()` 内のコメント番号が `1, 1.5, 3, 5, 6, 6.5` と欠番があり
(2, 4 が抜けている)、当初は該当スロットが想定されていたと推測される。

## 2. 実現可能性の再調査 (2026-09-02)

`three-filters-feasibility-report-20260902.txt` の実測結果:

### 2-1. 商品状態 (item_condition)

- **Mercari**: 検索 API items[].itemConditionId として **string "1"〜"6"** で
  取得可能。実測で 6 段階マッピングを確認 (server-side filter test)
  - "1" = 新品、未使用
  - "2" = 未使用に近い
  - "3" = 目立った傷や汚れなし
  - "4" = やや傷や汚れあり
  - "5" = 傷や汚れあり
  - "6" = 全体的に状態が悪い
- **Yahoo!フリマ**: 検索一覧 HTML には商品状態情報なし。取得には各商品詳細
  ページの追加 fetch が必要 → Puppeteer 起動コスト増 + Yahoo 429 リスク大幅
  上昇 (現状の 8kw allowlist 安定運用構成を大きく超過)。

### 2-2. 出品者評価 (sellerRating)

- **DB 実測**: DetectedItem.sellerRating は **22,489 行中 0 行 populate**、
  完全な dead column
- **Mercari**: 検索 API に seller rating フィールドなし。sellerId のみ返却。
  取得には `/api/v3/users/{sellerId}` 等の別 endpoint への追加呼び出しが
  必要 → 検索 120 items × N keywords 分の追加リクエスト → Mercari 429 リスク
  未検証
- **Yahoo**: 一覧 HTML に評価情報なし。詳細ページ fetch 必要 (同上リスク)

### 2-3. 賞味期限 (expiry)

- **Mercari**: 検索 API items[] に description / expiry / bestBefore 等の
  構造化フィールド皆無。attributes も空配列。詳細取得 API を使えば description
  自由記述が得られる可能性はあるが、テキスト抽出の精度見通しが立たない
  (「賞味期限 vs 消費期限」の概念違い、日付フォーマット多様性、
  false-positive/negative の見積り困難)
- **Yahoo**: 同様に構造化フィールドなし、詳細ページ fetch でも自由記述のみ

## 3. 決定 (今回のスコープ)

### 3-1. 実装した項目

**Mercari 商品状態フィルタ** — 唯一実装可能な項目として今回着手:

- `src/scrapers/MercariApiScraper.js`: search レスポンスから `itemConditionId`
  を item に追加取得
- `src/services/FilterService.js`: `check()` の step 4 に「商品状態」チェック
  を挿入
  - 判定: `item.itemConditionId && item.itemConditionId !== '1'` → NG
  - fail-open: undefined / null / '' (falsy 全般) は通過させる (Yahoo item
    または取得不能時への safety)
- `scripts/test-item-condition-filter.js`: 20 assert (cid=1〜6 / null /
  undefined / '' / number type / 既存 filter との順序保持 / 全通過)

### 3-2. 保留した項目 (今回スコープ外)

| 項目 | 保留理由 | 再検討の条件 |
|-----|---------|-------------|
| 商品状態 (Yahoo) | 詳細ページ fetch が必要、Yahoo 429 リスク大 (現状 8kw allowlist で辛うじて安定) | Yahoo scraper が詳細ページ対応 architecture になり、rate-limit マージンが確保された後 |
| 出品者評価 (Mercari) | 検索 API に rating フィールドなし。別 endpoint への追加呼び出しで 120x 増、429 リスク未検証 | seller info fetcher (dedup キャッシュ・rate-limit 対策付き) が別 sprint で実装された後 |
| 出品者評価 (Yahoo) | 上と同じ理由 (詳細ページ fetch 必要) | Yahoo scraper の architecture 改修後 |
| 賞味期限 (Mercari/Yahoo) | 構造化フィールドなし、テキスト抽出の精度見通し立たず | 「消費期限 vs 賞味期限」の概念整理と、regex 抽出の精度実測 (dry-run) 完了後 |

### 3-3. `DetectedItem.sellerRating` カラムの扱い

**削除せず残す**方針を採用。理由:

- 将来的に Mercari seller info fetcher が実装されれば、このカラムへ populate
  する経路ができる (すでにスキーマ側で受け入れ可)
- 削除には Sequelize migration + データ整合性確認が必要でコスト高
- FLOAT nullable なので DB サイズへの影響は極小 (22,489 行 × 8 bytes = 175 KB)
- ADR で「dead column である現状」と「populate される将来の想定」を明示すれば、
  後任者が「なぜ書き込まれない列があるのか」を追う際の hint になる

## 4. 実装ノート

### 4-1. Fail-open の定義

指示文で `null` のみ言及されていたが、実装では **falsy 全般** (undefined /
null / '') を fail-open として扱う。理由:

- Yahoo item は itemConditionId プロパティ自体が undefined
- Mercari API が「保守的に空文字を返す」可能性があるため safety margin
- 誤って新品案件を除外するより、通過させて既存の 他 filter (NG語句等) に
  委ねる方が「見逃しリスク」を下げる

### 4-2. Fail-close となる異常値: number 型

`itemConditionId = 1` (number、string ではなく) は `!== '1'` で NG となる
(fail-close)。Mercari API 仕様は string 返却なので、number が来るのは
「型が違う異常値」= scraper 側の bug 疑い。この場合は NG に倒し、上位で
warning を上げる想定 (今回は warning は未実装、必要になれば追加)。

### 4-3. Filter chain 内の挿入位置

既存 chain (下限価格 → 上限価格 → 出品経過時間 → NG語句 → グローバル除外 →
個別除外) の step 3 と step 5 の間、番号 4 として挿入。理由:

- 構造化フィールドの numeric/enum check (price/time と同分類) → 前半に置く
- string 検索 (NG語句/除外) より軽量なので前半に置く
- 元コメント番号の欠番 (4) にちょうど埋まる形

## 5. 検証・テスト

```
$ node scripts/test-item-condition-filter.js
=== 商品状態フィルタ (item_condition) ===
  PASS: cid="1" (新品、未使用) は通過
  PASS: cid="1" 通過時 reason=null
  PASS: cid="2" は NG
  ...
=== 結果: 20 passed, 0 failed ===
```

## 6. 参考: 変更ファイル (feat/mercari-item-condition-filter)

- `src/scrapers/MercariApiScraper.js` (+4 lines: itemConditionId 取得 + コメント)
- `src/services/FilterService.js` (+10 lines: step 4 追加 + コメント)
- `scripts/test-item-condition-filter.js` (新規、112 lines)
- `docs/decisions/2026-09-02-three-filters-implementation.md` (新規、本ファイル)

## 7. 変更履歴

- 2026-09-02: 初版作成 (Mercari 商品状態フィルタ実装、他 3 項目保留を記録)
