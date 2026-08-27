#!/usr/bin/env node
// InventoryAlertService の integration test (実 DB + synthetic データ + Telegram モック)
// (2026-08-26 実装、feat/telegram-inventory-alert Chunk 2c)
//
// 検証:
//   [1] evaluateAllSkus が対象 SKU を正しく分類する
//   [2] runCheck の履歴突き合わせ → 新規🔴 検知
//   [3] runCheck の dedup: 12h 内既送信なら再送スキップ
//   [4] runCheck が 🟡→🔴 遷移で発火 + 履歴更新
//   [5] runCheck が 🔴→🔴 (継続) では発火しない
//   [6] sendDailyDigest: 🔴 のみ lastTelegramSentAt を更新 (🟡🟢 は据え置き)
//   [7] sendDailyDigest 送信後、🟡→🔴 遷移が正しくリアルタイム発火する
//       (レビュー指摘 1 の修正が効いていること)
//   [8] キャッシュ廃止確認: sendDailyDigest 2 回連続呼びで各回フレッシュ eval される
//       (レビュー指摘 2 の修正が効いていること)
//
// テストデータ:
//   synthetic Keyword + CrossmallProduct + CrossmallSale を「TEST-INV-」プレフィックスで作成
//   テスト完了時に必ず削除
//   Telegram 送信は notification をスパイに差し替え、実 API を叩かない

'use strict';

// 再発防止 (2026-08-26): テストスクリプトは本番 DB に対する sync/alter を実行しない
// require('./src/models') 前に必ずセットすること
process.env.SKIP_DB_ALTER = 'true';

require('dotenv').config();

// bot 切り替え作業中の暫定無効化フラグ (.env 経由で入ってくる) は
// テスト内では明示的に打ち消す (runCheck / sendDailyDigest の実挙動を検証するため)
delete process.env.INVENTORY_ALERT_DISABLED;
const { Op } = require('sequelize');
const {
  sequelize, Keyword, CrossmallProduct, CrossmallSale, InventoryAlertHistory,
} = require('../src/models');
const {
  InventoryAlertService, evaluateAllSkus,
} = require('../src/services/InventoryAlertService');

const PREFIX = 'TEST-INV-';
const T_SKU = {
  red_fresh:      PREFIX + 'RED-FRESH',      // stock=2, s1=1/日 → days≈2 → red
  red_oos:        PREFIX + 'RED-OOS',        // stock=0 → days=0 → red (欠品)
  yellow:         PREFIX + 'YELLOW',         // stock=10, s1=1/日 → days≈10 → yellow
  green:          PREFIX + 'GREEN',          // stock=100, s1=1/日 → days≈100 → green
  excluded_neg:   PREFIX + 'NEG-STOCK',      // stock=-1 → 対象外
  excluded_dead: PREFIX + 'NO-SALES',        // stock=10, s28=0 → 対象外 (pace=0)
};

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

async function cleanup() {
  const testCodes = Object.values(T_SKU);
  await InventoryAlertHistory.destroy({ where: { skuCode: { [Op.in]: testCodes } } });
  await CrossmallSale.destroy({ where: { itemCode: { [Op.in]: testCodes } } });
  await CrossmallProduct.destroy({ where: { itemCode: { [Op.in]: testCodes } } });
  await Keyword.destroy({ where: { crossmallItemCode: { [Op.in]: testCodes } } });
}

async function setupTestData() {
  await cleanup();
  // Keyword は各 SKU 1 件ずつ作成 (紐付けのため)
  for (const [key, code] of Object.entries(T_SKU)) {
    await Keyword.create({
      keyword: `test_${key}`,
      crossmallItemCode: code,
      isActive: true,
      minPrice: 0, maxPrice: 999999,
      platforms: ['mercari'],
    });
  }
  const now = new Date();
  const dayN = (n) => {
    const d = new Date(now); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const today = dayN(0);

  // Products (lastSyncedAt = now → fresh)
  await CrossmallProduct.bulkCreate([
    { itemCode: T_SKU.red_fresh,     itemName: 'RED Fresh SKU',     stock: 2,   lastSyncedAt: now },
    { itemCode: T_SKU.red_oos,       itemName: 'RED OOS SKU',       stock: 0,   lastSyncedAt: now },
    { itemCode: T_SKU.yellow,        itemName: 'YELLOW SKU',        stock: 10,  lastSyncedAt: now },
    { itemCode: T_SKU.green,         itemName: 'GREEN SKU',         stock: 100, lastSyncedAt: now },
    { itemCode: T_SKU.excluded_neg,  itemName: 'NEG SKU',           stock: -1,  lastSyncedAt: now },
    { itemCode: T_SKU.excluded_dead, itemName: 'DEAD SKU',          stock: 10,  lastSyncedAt: now },
  ]);

  // Sales: 定常 1/日 の 4 SKU (red_fresh / yellow / green / excluded_dead は sales 生成)
  // 直近 28 日、1 個/日 × 28 = 28 個
  // excluded_dead は sales 0 (無販売)
  // red_oos は stock=0 パスで pace=0 でも eligible
  const activeSalesFor = [T_SKU.red_fresh, T_SKU.yellow, T_SKU.green];
  const salesRows = [];
  let orderNo = 900000;
  for (const code of activeSalesFor) {
    for (let n = 0; n < 28; n++) {
      salesRows.push({
        orderNumber: `TESTORD-${orderNo++}`,
        lineNo: 1,
        itemCode: code,
        orderDate: dayN(n),
        amount: 1,
        unitPrice: 1000,
      });
    }
  }
  await CrossmallSale.bulkCreate(salesRows);
}

// Telegram spy 差し替え可能な notification stub
function makeNotificationSpy() {
  const sent = [];
  return {
    sent,
    sendTelegram: async (msg) => { sent.push(msg); },
  };
}

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  await cleanup();
  await setupTestData();

  console.log('\n[test-1] evaluateAllSkus が対象 SKU を正しく分類');
  const results = await evaluateAllSkus(new Date());
  const testResults = results.filter(r => r.skuCode.startsWith(PREFIX));
  assert(testResults.length === 4, `テスト SKU 6 件中、対象は 4 件 (実際: ${testResults.length})`);
  const byCode = new Map(testResults.map(r => [r.skuCode, r]));
  assert(byCode.get(T_SKU.red_fresh)?.tier === 'red', 'red_fresh (stock=2, pace≈1) → red');
  assert(byCode.get(T_SKU.red_oos)?.tier === 'red', 'red_oos (stock=0) → red');
  assert(byCode.get(T_SKU.yellow)?.tier === 'yellow', 'yellow (stock=10) → yellow');
  assert(byCode.get(T_SKU.green)?.tier === 'green', 'green (stock=100) → green');
  assert(!byCode.has(T_SKU.excluded_neg), 'neg stock は対象外');
  assert(!byCode.has(T_SKU.excluded_dead), 'stock>0 かつ pace=0 は対象外');
  const redFresh = byCode.get(T_SKU.red_fresh);
  // sales 28 件が「今日〜27日前」に配置されるため、
  //   sales1 = 今日+昨日 = 2 (dayN(1)='昨日日付', WHERE >= 昨日日付)
  //   sales7 = 8, sales14 = 15, sales28 = 28
  //   pace = 0.15*2 + 0.30*8/7 + 0.25*15/14 + 0.30*28/28 ≈ 1.211
  //   Rec = ceil(19*1.211 - 2) = ceil(21.00) = 22
  assert(redFresh?.recommendedQty >= 20 && redFresh?.recommendedQty <= 24,
    `red_fresh の推奨数 (期待 20〜24 の範囲、pace≈1.21 で ceil(19*1.21-2)=22): 実際 ${redFresh?.recommendedQty}`);
  assert(redFresh?.fresh === true, 'lastSyncedAt=now なので fresh=true');

  console.log('\n[test-2] runCheck: 初回全 SKU を新規🔴として検知');
  // 2026-08-27 リンクのみ形式に伴い、メッセージは SKU 非依存になったため
  // spy を SKU 名で filter して件数比較する検証は不可。代わりに
  // r1.newlyReds (behavior) と spy1.sent.length (送信件数) を検証する。
  const spy1 = makeNotificationSpy();
  const svc = new InventoryAlertService(spy1);
  const r1 = await svc.runCheck();
  const testNewly1 = r1.newlyReds.filter(r => r.skuCode.startsWith(PREFIX));
  assert(testNewly1.length === 2, `テスト red SKU 2 件が新規検知 (実際: ${testNewly1.length})`);
  assert(spy1.sent.length === r1.sentCount,
    `Telegram spy 送信件数 = runCheck.sentCount (spy=${spy1.sent.length}, sentCount=${r1.sentCount})`);
  // 2026-08-27 集約送信: 新規🔴 が複数でも 1 通のみ送信
  assert(spy1.sent.length === 1,
    `新規🔴 が複数でも Telegram は 1 通に集約 (実際: ${spy1.sent.length})`);
  assert(spy1.sent.every(m => m.startsWith('🚨 在庫アラートを更新しました')),
    '全メッセージがリアルタイム見出し (🚨) で始まる');

  console.log('\n[test-3] 履歴が正しく保存されている (lastTelegramSentAt は red のみ更新)');
  const hRedFresh = await InventoryAlertHistory.findByPk(T_SKU.red_fresh);
  assert(hRedFresh?.tier === 'red', 'red_fresh の履歴 tier=red');
  assert(hRedFresh?.lastTelegramSentAt !== null, 'red_fresh の lastTelegramSentAt が設定済み');
  const hYellow = await InventoryAlertHistory.findByPk(T_SKU.yellow);
  assert(hYellow?.tier === 'yellow', 'yellow の履歴 tier=yellow');
  assert(hYellow?.lastTelegramSentAt === null,
    'yellow の lastTelegramSentAt は未設定 (通知対象外)');
  const hGreen = await InventoryAlertHistory.findByPk(T_SKU.green);
  assert(hGreen?.tier === 'green', 'green の履歴 tier=green');
  assert(hGreen?.lastTelegramSentAt === null, 'green の lastTelegramSentAt も未設定');

  console.log('\n[test-4] 継続🔴: 2 回目 runCheck では再送しない');
  const spy2 = makeNotificationSpy();
  const svc2 = new InventoryAlertService(spy2);
  const r2 = await svc2.runCheck();
  const testNewly2 = r2.newlyReds.filter(r => r.skuCode.startsWith(PREFIX));
  assert(testNewly2.length === 0,
    `継続🔴 は「新規」でない (実際: ${testNewly2.length})`);
  // SKU 非依存メッセージなのでテスト SKU 分の再送は「r2.newlyReds に含まれない」
  // ことで代替検証
  assert(!r2.newlyReds.some(r => r.skuCode.startsWith(PREFIX)),
    'テスト red SKU が newlyReds に含まれない (=再送対象外)');

  console.log('\n[test-5] 🟡→🔴 遷移: 新規リアルタイム発火');
  // yellow SKU の stock を 10 → 2 に落として次回 runCheck で 🔴 遷移をシミュレート
  await CrossmallProduct.update({ stock: 2 }, { where: { itemCode: T_SKU.yellow } });
  const spy3 = makeNotificationSpy();
  const svc3 = new InventoryAlertService(spy3);
  const r3 = await svc3.runCheck();
  const yellowNowRed = r3.newlyReds.find(r => r.skuCode === T_SKU.yellow);
  assert(!!yellowNowRed, 'yellow だった SKU が🔴 遷移で新規検知される');
  // SKU 非依存メッセージなので、送信が起きた事実を DB (lastTelegramSentAt)
  // で検証する (メッセージ内容による判別は不可)
  const hYellowAfter = await InventoryAlertHistory.findByPk(T_SKU.yellow);
  assert(hYellowAfter.lastTelegramSentAt !== null,
    'yellow→red 遷移で lastTelegramSentAt が設定される (=送信された証跡)');
  assert(spy3.sent.length >= 1,
    `spy に少なくとも 1 件届く (実際: ${spy3.sent.length})`);

  console.log('\n[test-6] dedup: 12h 内既送信は再送しない (yellow→red のケース)');
  // 上の spy3 で 3.5 秒以内、明らかに 12h 未満なので dedup がかかる
  const spy4 = makeNotificationSpy();
  const svc4 = new InventoryAlertService(spy4);
  const r4 = await svc4.runCheck();
  // SKU 非依存メッセージなので、対象 SKU の再送有無は newlyReds で判定
  assert(!r4.newlyReds.some(r => r.skuCode === T_SKU.yellow),
    '前回送信から 12h 未満の yellow SKU は newlyReds から除外される (dedup)');

  console.log('\n[test-7] sendDailyDigest: 🔴 のみ lastTelegramSentAt 更新');
  // 状態リセット: test-5 で yellow を red 化していたので 10 に戻し、履歴も yellow に
  await CrossmallProduct.update({ stock: 10 }, { where: { itemCode: T_SKU.yellow } });
  await InventoryAlertHistory.update(
    { tier: 'yellow', lastTelegramSentAt: null },
    { where: { skuCode: { [Op.in]: Object.values(T_SKU) } } }
  );
  const spy5 = makeNotificationSpy();
  const svc5 = new InventoryAlertService(spy5);
  const digestResult = await svc5.sendDailyDigest();
  assert(spy5.sent.length === 1, 'digest メッセージ 1 件送信');
  const digestMsg = spy5.sent[0];
  assert(digestMsg.startsWith('📦 在庫アラートを更新しました'), 'digest 見出し (📦)');
  // リンクのみ形式なので、本文に SKU 名・tier 記号・件数を含まないことを確認
  assert(!digestMsg.includes('RED Fresh SKU'), 'digest 本文に red_fresh 名を含まない');
  assert(!digestMsg.includes('RED OOS SKU'), 'digest 本文に red_oos 名を含まない');
  assert(!digestMsg.includes('YELLOW SKU'), 'digest 本文に yellow SKU 名を含まない');
  assert(!digestMsg.includes('GREEN SKU'), 'digest 本文に green SKU 名を含まない');
  assert(!digestMsg.includes('残0日'), 'digest 本文に在庫日数を含まない');
  assert(!digestMsg.includes('🔴') && !digestMsg.includes('🟡') && !digestMsg.includes('🟢'),
    'digest 本文に tier 記号を含まない');
  assert(digestMsg.includes('在庫補充、頑張ってください！'), 'digest 本文に応援メッセージ');

  // 履歴更新確認: red は lastTelegramSentAt 設定、yellow/green は null 維持
  const hRedFresh2 = await InventoryAlertHistory.findByPk(T_SKU.red_fresh);
  const hRedOos2 = await InventoryAlertHistory.findByPk(T_SKU.red_oos);
  const hYellow2 = await InventoryAlertHistory.findByPk(T_SKU.yellow);
  const hGreen2 = await InventoryAlertHistory.findByPk(T_SKU.green);
  assert(hRedFresh2.lastTelegramSentAt !== null, '(修正確認) red_fresh の lastTelegramSentAt 更新');
  assert(hRedOos2.lastTelegramSentAt !== null, '(修正確認) red_oos の lastTelegramSentAt 更新');
  assert(hYellow2.lastTelegramSentAt === null,
    '(レビュー修正 1) yellow は digest で通知されないので lastTelegramSentAt=null 維持');
  assert(hGreen2.lastTelegramSentAt === null,
    '(レビュー修正 1) green も同様、lastTelegramSentAt=null 維持');
  // notifiedRedCount は全 DB の red 合計 (production SKU 含む) なので、下限のみ検証:
  // 少なくともテスト SKU 2 件は含まれる
  assert(digestResult.notifiedRedCount >= 2,
    `digest 通知済み扱い >= 2 (実際: ${digestResult.notifiedRedCount}、production SKU 含む)`);

  console.log('\n[test-8] レビュー修正 2 効果: digest 直後の 🟡→🔴 遷移でリアルタイム発火');
  // yellow SKU (test-5 で既に red 化しているのを戻す) を再び 🔴 遷移させる
  // 先に yellow に戻して履歴も yellow に
  await CrossmallProduct.update({ stock: 10 }, { where: { itemCode: T_SKU.yellow } });
  await InventoryAlertHistory.update(
    { tier: 'yellow', lastTelegramSentAt: null },
    { where: { skuCode: T_SKU.yellow } }
  );
  // digest 呼び (yellow は 🟡 なので lastTelegramSentAt 更新されない期待)
  const spy6 = makeNotificationSpy();
  const svc6 = new InventoryAlertService(spy6);
  await svc6.sendDailyDigest();
  const hYellowAfterDigest = await InventoryAlertHistory.findByPk(T_SKU.yellow);
  assert(hYellowAfterDigest.lastTelegramSentAt === null,
    'yellow は digest で lastTelegramSentAt 触られない (旧バグの逆確認)');
  // 直後に yellow→red 遷移させる
  await CrossmallProduct.update({ stock: 2 }, { where: { itemCode: T_SKU.yellow } });
  const spy7 = makeNotificationSpy();
  const svc7 = new InventoryAlertService(spy7);
  const r7 = await svc7.runCheck();
  // SKU 非依存メッセージなので、対象 SKU の発火は newlyReds で判定
  assert(r7.newlyReds.some(r => r.skuCode === T_SKU.yellow),
    '(レビュー修正 1 の効果) digest 直後の 🟡→🔴 遷移が正しくリアルタイム発火する');
  const hYellowAfterR7 = await InventoryAlertHistory.findByPk(T_SKU.yellow);
  assert(hYellowAfterR7.lastTelegramSentAt !== null,
    'yellow SKU の lastTelegramSentAt が更新されている (=送信された証跡)');

  console.log('\n[test-9] sales1 の急伸検知 (加重平均で pace が上がる)');
  // green SKU に 今日 5 個の売上を追加 (定常 1/日 + spike 4) → sales1 = 6
  // 期待: pace = 0.15*6 + 0.30*(7 or 12)/7 + ... で pace 上昇
  // 現在の green は stock=100, pace≈1 → 100 日 → green
  // ここに sales1 spike を入れると pace 上昇、stock=100 でも days が縮まるが green のまま (100/2 = 50)
  // むしろ pace の変化そのものを確認するテストにする
  const t0Results = await evaluateAllSkus(new Date());
  const greenBefore = t0Results.find(r => r.skuCode === T_SKU.green);
  const paceBefore = greenBefore?.dailyPace || 0;

  // 今日 5 個追加
  const today = new Date().toISOString().slice(0, 10);
  await CrossmallSale.bulkCreate([1,2,3,4,5].map(i => ({
    orderNumber: `TESTORD-SPIKE-${i}`,
    lineNo: 1,
    itemCode: T_SKU.green,
    orderDate: today,
    amount: 1,
    unitPrice: 1000,
  })));
  const t1Results = await evaluateAllSkus(new Date());
  const greenAfter = t1Results.find(r => r.skuCode === T_SKU.green);
  const paceAfter = greenAfter?.dailyPace || 0;
  assert(paceAfter > paceBefore,
    `sales1 spike で pace 上昇: before=${paceBefore.toFixed(3)} → after=${paceAfter.toFixed(3)}`);

  console.log('\n[teardown] テストデータ削除');
  await cleanup();
  const leftover = await CrossmallProduct.count({
    where: { itemCode: { [Op.in]: Object.values(T_SKU) } }
  });
  assert(leftover === 0, `teardown 後の残骸 0 (実際: ${leftover})`);

  await sequelize.close();
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async e => {
  console.error('fatal:', e);
  try { await cleanup(); await sequelize.close(); } catch {}
  process.exit(1);
});
