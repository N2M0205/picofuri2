// Cold tier first-n-tokens モードから除外するキーワード ID リスト
// (2026-08-11 追加、feat/matches-opt-out-list)
//
// 背景: feat/matches-first-n-cold で Cold tier を first-n-tokens (N=3) に
//   切り替えた際、同一 Mercari itemId が複数キーワードに同時マッチする
//   attribution 問題が dry-run で検出された。
//   NEW モードで matchCount≥3 の item が 44→146 に増加、
//   特に N organic Vie 系 3keyword (id=139/140/141) が 185 item を完全共有し、
//   race に負けた側の SKU で利益計算されるリスクがあった。
//
// 対応: 影響が大きい 4 グループ 13 keyword を first-n から除外し、
//   従来の and-full マッチに戻す。
//
// 除外しない (first-n 対象に維持):
//   - id=189 「Ｎ organic」        : Ｎ organic 全般網羅目的、意図的に広範
//   - id=193 「エヌ オーガニック」   : 同上、カナ表記全般網羅
//   その他 Cold キーワードは従来通り first-n の恩恵を受ける。

'use strict';

const FIRST_N_OPT_OUT_KEYWORD_IDS = new Set([
  // N organic Vie/Basic 個別 SKU 5件
  139, 140, 141, 151, 168,
  // ラフドット (Sweet Bouquet / Relax Verbena / Pure Musk 3 SKU)
  131, 177, 178,
  // ユリイロ (Cherry-adjacent + White Lily / Body Oil 系 3件)
  57, 156, 196,
  // SHIRORU (Crystal Whip 2 SKU)
  150, 166,
]);

module.exports = { FIRST_N_OPT_OUT_KEYWORD_IDS };
