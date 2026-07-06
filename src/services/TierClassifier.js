// Hot/Warm/Cold 階層分類ロジック
//
// 分類は unique SKU 単位 (crossmallItemCode ベース、KeywordGroupService を利用) で行い、
// 同一 SKU を指す全キーワードに同じ階層を適用する。
//
// 階層定義:
//   Hot  : 在庫日数 ≤ HOT_THRESHOLD_DAYS (デフォルト 3日)
//   Warm : HOT_THRESHOLD_DAYS < 在庫日数 ≤ WARM_THRESHOLD_DAYS (デフォルト 14日)
//   Cold : それ以外 (在庫日数 ≥ WARM_THRESHOLD_DAYS + 1、または以下の対象外グループ)
//     ・stock ≤ 0 (欠品 / 負在庫)
//     ・sales28 = 0 (無限日数)
//     ・crossmallItemCode 未設定
//     ・CrossmallProduct 側にレコード不在
//
// 在庫日数計算: round(stock * 28 / sales28)
//   NotificationService.calcStockDays と同じ式。sales28=0 は Cold に集約。

'use strict';

const { CrossmallProduct } = require('../models');
const { getKeywordGroups } = require('./KeywordGroupService');

const TIER = Object.freeze({ HOT: 'hot', WARM: 'warm', COLD: 'cold' });

function stockDays(stock, sales28) {
  if (!sales28 || sales28 <= 0) return Infinity;
  return Math.round((stock * 28) / sales28);
}

/**
 * 全キーワードを Hot/Warm/Cold に分類する。
 *
 * @returns {Promise<{ hot: Keyword[], warm: Keyword[], cold: Keyword[], meta: object }>}
 *   meta: 内訳詳細 (unmapped / noProduct / oos / negativeStock / coldInf / coldFinite / warm / hot の件数)
 */
async function classifyAll() {
  const hotMax = parseInt(process.env.HOT_THRESHOLD_DAYS, 10) || 3;
  const warmMax = parseInt(process.env.WARM_THRESHOLD_DAYS, 10) || 14;

  const groups = await getKeywordGroups();
  const codes = [...new Set(groups.map(g => g.itemCode).filter(Boolean))];
  const prods = codes.length
    ? await CrossmallProduct.findAll({ where: { itemCode: codes }, raw: true })
    : [];
  const prodMap = new Map(prods.map(p => [p.itemCode, p]));

  const buckets = { hot: [], warm: [], cold: [] };
  const meta = {
    hot: 0, warm: 0,
    coldFinite: 0, coldInf: 0,
    oos: 0, negativeStock: 0, noProduct: 0, unmapped: 0,
  };

  for (const g of groups) {
    let tier;
    let reason;

    if (!g.itemCode) {
      tier = TIER.COLD;
      reason = 'unmapped';
    } else {
      const p = prodMap.get(g.itemCode);
      if (!p) {
        tier = TIER.COLD;
        reason = 'noProduct';
      } else {
        const stock = p.stock || 0;
        const sales28 = p.sales28 || 0;
        if (stock < 0) {
          tier = TIER.COLD;
          reason = 'negativeStock';
        } else if (stock === 0) {
          tier = TIER.COLD;
          reason = 'oos';
        } else if (sales28 === 0) {
          tier = TIER.COLD;
          reason = 'coldInf';
        } else {
          const days = stockDays(stock, sales28);
          if (days <= hotMax) { tier = TIER.HOT; reason = 'hot'; }
          else if (days <= warmMax) { tier = TIER.WARM; reason = 'warm'; }
          else { tier = TIER.COLD; reason = 'coldFinite'; }
        }
      }
    }

    // Group 内の全キーワードを同じ階層へ
    for (const kw of g.keywords) {
      buckets[tier].push(kw);
    }
    meta[reason] += g.keywords.length;
  }

  return { ...buckets, meta };
}

module.exports = { classifyAll, stockDays, TIER };
