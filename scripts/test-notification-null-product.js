#!/usr/bin/env node
// NotificationService.buildMessage の null product 対応検証テスト
// 2026-08-31 追加、fix/notification-null-product-stock-days
//
// 検証対象:
//   (a) product = null → 「📦 在庫情報なし」と「📅 在庫日数: 不明」が両立
//   (b) product あり + stock=0, sales28>0 → 「📅 在庫日数: 約0日」（本当の欠品、既存動作維持）
//   (c) product あり + stock>0, sales28=0 → 「📅 在庫日数: ∞」（既存動作維持）
//   (d) product あり + stock>0, sales28>0 → 「📅 在庫日数: 約N日」（既存動作維持）
//   (e) crossmallLine と stockDaysStr の整合性

'use strict';

const NotificationService = require('../src/services/NotificationService');

const ns = new NotificationService();
let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

// buildMessage は Telegram/LINE 送信を伴わない純ロジック関数として扱えるため
// テストで直接呼び出せる (line 132-156 は文字列組み立てのみ)

const baseItem = {
  id: 'm12345',
  platform: 'mercari',
  title: 'テスト商品',
  price: 3000,
  itemUrl: 'https://jp.mercari.com/item/m12345',
  listingCount: 5,
  listedAt: new Date().toISOString(),
};
const baseKeyword = {
  id: 999,
  keyword: 'テスト',
  crossmallItemCode: '2314-999999',
};

console.log('\n[test-a] product = null → 「在庫情報なし」+「在庫日数: 不明」');
{
  const msg = ns.buildMessage(baseItem, baseKeyword, null);
  assert(msg.includes('📦 在庫情報なし'), 'A1. crossmallLine = 在庫情報なし');
  assert(msg.includes('📅 在庫日数: 不明'), 'A2. stockDaysStr = 不明 (バグ修正確認)');
  assert(!msg.includes('約0日'), 'A3. 「約0日」が出ないことを念のため確認');
  assert(!msg.includes('📅 在庫日数: ∞'), 'A4. ∞ でもないことを確認');
}

console.log('\n[test-b] product あり + stock=0, sales28>0 → 「在庫日数: 約0日」(既存動作、真の欠品)');
{
  const product = { stock: 0, sales28: 10, sales7: 3, lastSalePrice: 2000, lastSaleDate: new Date().toISOString(), deliveryType: null };
  const msg = ns.buildMessage(baseItem, baseKeyword, product);
  assert(msg.includes('📦 在庫0個'), 'B1. crossmallLine = 在庫0個');
  assert(msg.includes('📅 在庫日数: 約0日'), 'B2. stockDaysStr = 約0日 (欠品状態、既存動作維持)');
  assert(msg.includes('⚫欠品中'), 'B3. 欠品バッジ ⚫欠品中 が付く');
}

console.log('\n[test-c] product あり + stock>0, sales28=0 → 「在庫日数: ∞」(既存動作)');
{
  const product = { stock: 5, sales28: 0, sales7: 0, lastSalePrice: 2000, lastSaleDate: null, deliveryType: null };
  const msg = ns.buildMessage(baseItem, baseKeyword, product);
  assert(msg.includes('📦 在庫5個'), 'C1. crossmallLine = 在庫5個');
  assert(msg.includes('📅 在庫日数: ∞'), 'C2. stockDaysStr = ∞ (販売実績なしで在庫あり、既存動作維持)');
  assert(!msg.includes('⚫欠品中'), 'C3. 欠品バッジは付かない');
}

console.log('\n[test-d] product あり + stock>0, sales28>0 → 「在庫日数: 約N日」(既存動作)');
{
  const product = { stock: 10, sales28: 14, sales7: 3, lastSalePrice: 2500, lastSaleDate: null, deliveryType: null };
  const msg = ns.buildMessage(baseItem, baseKeyword, product);
  // stockDays = round(10 / (14/28)) = round(20) = 20
  assert(msg.includes('📦 在庫10個'), 'D1. crossmallLine = 在庫10個');
  assert(msg.includes('📅 在庫日数: 約20日'), 'D2. stockDaysStr = 約20日 (通常計算、既存動作維持)');
}

console.log('\n[test-e] crossmallLine と stockDaysStr の整合性 (両者とも「データなし」を示す)');
{
  const msg = ns.buildMessage(baseItem, baseKeyword, null);
  const lines = msg.split('\n');
  const cLine = lines.find(l => l.startsWith('📦'));
  const dLine = lines.find(l => l.startsWith('📅'));
  assert(cLine === '📦 在庫情報なし', 'E1. crossmallLine が「在庫情報なし」で始まる');
  assert(dLine === '📅 在庫日数: 不明', 'E2. stockDaysLine が「在庫日数: 不明」で終わる');
  // 両行が「データなし」を示す表現で並んでいる ← 意味論の整合
  assert(cLine.includes('情報なし') && dLine.includes('不明'),
    'E3. 両行とも「データなし」を示す表現になっている (矛盾解消)');
}

console.log('\n[test-f] product = undefined でも null と同じ挙動');
{
  const msg = ns.buildMessage(baseItem, baseKeyword, undefined);
  assert(msg.includes('📦 在庫情報なし'), 'F1. undefined でも「在庫情報なし」');
  assert(msg.includes('📅 在庫日数: 不明'), 'F2. undefined でも「不明」');
}

console.log('\n=== 結果 ===');
console.log(`passed=${passed}, failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
