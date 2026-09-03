// test/fetch-rakuten-prices.test.js
// scripts/lib/rakuten-price-lib.js の純粋関数を node --test で検証。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  extractPrice,
  extractImageUrl,
} = require('../scripts/lib/rakuten-price-lib');

// ============================================================================
// extractPrice
// ============================================================================

test('extractPrice: 単一 variant 数値', () => {
  const item = { variants: { 'r-sku00000001': { standardPrice: 5680 } } };
  assert.deepStrictEqual(extractPrice(item), { price: 5680, variantCount: 1 });
});

test('extractPrice: 単一 variant 文字列', () => {
  const item = { variants: { 'a': { standardPrice: '4320' } } };
  assert.deepStrictEqual(extractPrice(item), { price: 4320, variantCount: 1 });
});

test('extractPrice: 複数 variant → 最小価格', () => {
  const item = { variants: {
    a: { standardPrice: 3000 },
    b: { standardPrice: 5000 },
    c: { standardPrice: 4000 },
  } };
  assert.deepStrictEqual(extractPrice(item), { price: 3000, variantCount: 3 });
});

test('extractPrice: カンマ区切り', () => {
  const item = { variants: { a: { standardPrice: '1,234' } } };
  assert.deepStrictEqual(extractPrice(item), { price: 1234, variantCount: 1 });
});

test('extractPrice: variants なし', () => {
  assert.deepStrictEqual(extractPrice({}), { price: null, variantCount: 0 });
  assert.deepStrictEqual(extractPrice(null), { price: null, variantCount: 0 });
  assert.deepStrictEqual(extractPrice({ variants: null }), { price: null, variantCount: 0 });
});

test('extractPrice: variants が空オブジェクト', () => {
  assert.deepStrictEqual(extractPrice({ variants: {} }), { price: null, variantCount: 0 });
});

test('extractPrice: standardPrice 欠落 variants', () => {
  const item = { variants: { a: { }, b: { standardPrice: null }, c: { standardPrice: '' } } };
  assert.deepStrictEqual(extractPrice(item), { price: null, variantCount: 3 });
});

test('extractPrice: 一部 variant のみ有効', () => {
  const item = { variants: { a: { }, b: { standardPrice: 2000 } } };
  assert.deepStrictEqual(extractPrice(item), { price: 2000, variantCount: 2 });
});

// ============================================================================
// extractImageUrl
// ============================================================================

const SHOP = 'honmachi-store';
const BASE = `https://image.rakuten.co.jp/${SHOP}`;

test('extractImageUrl: CABINET 相対 (先頭 /)', () => {
  const item = { images: [{ type: 'CABINET', location: '/08436692/10329741/00000109.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), `${BASE}/cabinet/08436692/10329741/00000109.jpg`);
});

test('extractImageUrl: CABINET 相対 (先頭 / なし)', () => {
  const item = { images: [{ type: 'CABINET', location: '08436692/xxx.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), `${BASE}/cabinet/08436692/xxx.jpg`);
});

test('extractImageUrl: type 未指定は CABINET 扱い', () => {
  const item = { images: [{ location: '/image/x.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), `${BASE}/cabinet/image/x.jpg`);
});

test('extractImageUrl: 絶対 URL はそのまま', () => {
  const item = { images: [{ type: 'CABINET', location: 'https://image.rakuten.co.jp/other-shop/cabinet/x.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), 'https://image.rakuten.co.jp/other-shop/cabinet/x.jpg');
});

test('extractImageUrl: http:// 絶対もそのまま', () => {
  const item = { images: [{ location: 'http://example.com/a.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), 'http://example.com/a.jpg');
});

test('extractImageUrl: GOLD 相対', () => {
  const item = { images: [{ type: 'GOLD', location: '/g/x.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), `${BASE}/gold/g/x.jpg`);
});

test('extractImageUrl: 未対応 type かつ 相対 → null', () => {
  const item = { images: [{ type: 'EXTERNAL', location: '/x.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), null);
});

test('extractImageUrl: images 空配列 → null', () => {
  assert.strictEqual(extractImageUrl({ images: [] }, SHOP), null);
});

test('extractImageUrl: images 非配列 → null', () => {
  assert.strictEqual(extractImageUrl({ images: null }, SHOP), null);
  assert.strictEqual(extractImageUrl({ images: 'foo' }, SHOP), null);
  assert.strictEqual(extractImageUrl({}, SHOP), null);
});

test('extractImageUrl: images[0] が null / 非オブジェクト → null', () => {
  assert.strictEqual(extractImageUrl({ images: [null] }, SHOP), null);
  assert.strictEqual(extractImageUrl({ images: ['foo'] }, SHOP), null);
});

test('extractImageUrl: location 欠落 or 空文字 → null', () => {
  assert.strictEqual(extractImageUrl({ images: [{ type: 'CABINET' }] }, SHOP), null);
  assert.strictEqual(extractImageUrl({ images: [{ type: 'CABINET', location: '' }] }, SHOP), null);
  assert.strictEqual(extractImageUrl({ images: [{ type: 'CABINET', location: '   ' }] }, SHOP), null);
});

test('extractImageUrl: shopId 欠落 → null', () => {
  const item = { images: [{ type: 'CABINET', location: '/x.jpg' }] };
  assert.strictEqual(extractImageUrl(item, ''), null);
  assert.strictEqual(extractImageUrl(item, null), null);
  assert.strictEqual(extractImageUrl(item, undefined), null);
});

test('extractImageUrl: item 自体が null → null', () => {
  assert.strictEqual(extractImageUrl(null, SHOP), null);
  assert.strictEqual(extractImageUrl(undefined, SHOP), null);
});

test('extractImageUrl: 大文字小文字混じり type', () => {
  const item = { images: [{ type: 'cabinet', location: '/x.jpg' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), `${BASE}/cabinet/x.jpg`);
});

test('extractImageUrl: 前後スペース (location trim)', () => {
  const item = { images: [{ type: 'CABINET', location: '  /x.jpg  ' }] };
  assert.strictEqual(extractImageUrl(item, SHOP), `${BASE}/cabinet/x.jpg`);
});
