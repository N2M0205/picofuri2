// scripts/lib/rakuten-price-lib.js
// fetch-rakuten-prices.js の純粋関数レイヤ。DB・HTTP に依存せず、テスト可能。

'use strict';

// items/search レスポンスの item.variants から standardPrice を取得。
// 複数 variant がある場合は最小価格を採用 (フロア価格) — 監視の「安値検出」
// 用途としては最も保守的な値。
function extractPrice(item) {
  const variants = item && item.variants;
  if (!variants || typeof variants !== 'object') return { price: null, variantCount: 0 };
  const keys = Object.keys(variants);
  if (keys.length === 0) return { price: null, variantCount: 0 };
  const prices = [];
  for (const k of keys) {
    const raw = variants[k] && variants[k].standardPrice;
    if (raw === undefined || raw === null || raw === '') continue;
    const n = parseInt(String(raw).replace(/[,\s]/g, ''), 10);
    if (Number.isFinite(n)) prices.push(n);
  }
  if (prices.length === 0) return { price: null, variantCount: keys.length };
  return { price: Math.min(...prices), variantCount: keys.length };
}

// items/search レスポンスの item.images[0].location を絶対 URL 化。
// 仕様:
//   - images が非配列 or 空 → null
//   - images[0].location が空文字 or 欠落 → null
//   - location が http(s):// で始まる → そのまま
//   - type === 'CABINET' (or 未指定) かつ 相対パス → CABINET base で絶対化
//     https://image.rakuten.co.jp/<shopId>/cabinet<location>
//     location 先頭 '/' 有無どちらでも動作するよう normalize
//   - type === 'GOLD' → https://image.rakuten.co.jp/<shopId>/gold<location>
//   - 他 type かつ 相対 → null (未対応の type)
function extractImageUrl(item, shopId) {
  if (!shopId || typeof shopId !== 'string') return null;
  const images = item && item.images;
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0];
  if (!first || typeof first !== 'object') return null;
  const loc = first.location;
  if (typeof loc !== 'string' || loc.trim() === '') return null;
  const trimmed = loc.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const normalizedPath = trimmed.startsWith('/') ? trimmed : '/' + trimmed;
  const type = (first.type || 'CABINET').toUpperCase();
  if (type === 'CABINET') {
    return `https://image.rakuten.co.jp/${shopId}/cabinet${normalizedPath}`;
  }
  if (type === 'GOLD') {
    return `https://image.rakuten.co.jp/${shopId}/gold${normalizedPath}`;
  }
  return null;
}

module.exports = {
  extractPrice,
  extractImageUrl,
};
