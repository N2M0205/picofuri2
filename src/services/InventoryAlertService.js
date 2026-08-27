// Telegram 在庫アラートのコアロジック
// (2026-08-26 実装、feat/telegram-inventory-alert)
//
// 設計: 指示書 v2 に基づく確定仕様。詳細は
//   - src/config/inventoryAlert.json (閾値・重み・cron 設定)
//   - INVENTORY-ALERT-FACT-CHECK-20260826.md (事実確認)
// を参照。
//
// 責務:
//   1. sales1 / sales14 を CrossmallSale から算出 (既存 _updateProductStats は無変更)
//   2. 日販ペース = 重み付き平均 (0.15·s1 + 0.30·s7/7 + 0.25·s14/14 + 0.30·s28/28)
//   3. 在庫日数 = stock / 日販ペース (stock=0 は 0 日 = 🔴 に振る、日販=0 は判定不可)
//   4. 3 段階 tier 判定 (red/yellow/green)
//   5. 推奨仕入数 = (14 + 5) × 日販ペース − 現在庫、負値は 0
//   6. 鮮度判定: lastSyncedAt から 4h 超過で ⚠️
//   7. 判定対象 SKU の絞り込み (crossmallItemCode 必須, master 有, stock>=0, 日販>0 or stock=0)
//   8. InventoryAlertHistory との突き合わせで「新規 🔴 遷移」検知 + 同日重複防止
//   9. Telegram broadcast (NotificationService.sendTelegram)
//  10. HTML ダッシュボード用のデータ構造を返す

'use strict';

const { Op } = require('sequelize');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const {
  sequelize, Keyword, CrossmallProduct, CrossmallSale, InventoryAlertHistory,
} = require('../models/index.js');
const config = require('../config/inventoryAlert.json');

// ==================== 独立 Telegram 送信 (2026-08-26 追加) ====================
// 在庫アラートは @picofuri_admin_bot (キーワード管理と同一 bot) から送信する。
// 既存 NotificationService.sendTelegram は @picofuri2_bot を使うため、
// 混同を避けるため独立実装 (別トークン・別関数)。
// polling プロセス (別ホスト・別 process) には一切干渉しない。
//
// 送信先 chat_ids は既存の TELEGRAM_CHAT_IDS (owner + koba) をそのまま流用。
// TELEGRAM_ADMIN_ID (旧単一 chat_id 変数) は broadcast の後方互換 fallback として使う。
//
// トークンは INVENTORY_ALERT_BOT_TOKEN 環境変数から取る。未設定なら send は
// no-op (WARN ログのみ)。
class InventoryAlertTelegramClient {
  constructor(opts = {}) {
    // 環境変数はコンストラクタ時に snapshot (pm2 restart --update-env で反映)
    this.token = opts.token || process.env.INVENTORY_ALERT_BOT_TOKEN;
    this.chatIds = opts.chatIds
      || InventoryAlertTelegramClient._parseChatIds(
        process.env.TELEGRAM_CHAT_IDS,
        process.env.TELEGRAM_ADMIN_ID,
      );
  }

  static _parseChatIds(csv, fallbackSingle) {
    if (csv && csv.trim()) return csv.split(',').map(s => s.trim()).filter(Boolean);
    if (fallbackSingle && String(fallbackSingle).trim()) return [String(fallbackSingle).trim()];
    return [];
  }

  // 使い勝手を NotificationService.sendTelegram に合わせる (spy 差し替え互換)。
  // 全 chat_id へ順次配信、片方失敗しても他方は継続。
  async sendTelegram(message) {
    if (!this.token || this.chatIds.length === 0) {
      console.warn('[InventoryAlert] Telegram token / chatIds 未設定、送信スキップ');
      return;
    }
    for (const chatId of this.chatIds) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${this.token}/sendMessage`,
          { chat_id: chatId, text: message },
          { timeout: 10000 },
        );
      } catch (e) {
        console.error(`[InventoryAlert] chat_id=${chatId} 送信エラー:`, e.response?.status, e.message);
      }
    }
  }
}

// ==================== 純関数 (単体テスト対象) ====================

/**
 * 日販ペースの重み付き平均を返す。
 * 定義: 0.15*(sales1/1) + 0.30*(sales7/7) + 0.25*(sales14/14) + 0.30*(sales28/28)
 * (指示書 v2 で確定。配分値は config.sales_weights から差替可)
 * @param {{sales1:number, sales7:number, sales14:number, sales28:number}} sales
 * @param {{d1:number, d7:number, d14:number, d28:number}} weights
 * @returns {number}
 */
function calcDailySalesPace(sales, weights) {
  const s1  = (sales.sales1  ?? 0);
  const s7  = (sales.sales7  ?? 0);
  const s14 = (sales.sales14 ?? 0);
  const s28 = (sales.sales28 ?? 0);
  return weights.d1  * (s1  / 1)
       + weights.d7  * (s7  / 7)
       + weights.d14 * (s14 / 14)
       + weights.d28 * (s28 / 28);
}

/**
 * 在庫日数 = stock / dailyPace (dailyPace=0 は Infinity、stock<=0 は 0)
 */
function calcStockDaysFromPace(stock, dailyPace) {
  if (stock == null) return null;
  if (stock <= 0) return 0;
  if (dailyPace == null || dailyPace <= 0) return Infinity;
  return stock / dailyPace;
}

/**
 * 在庫日数 → 3 段階 tier
 *   ≤ red_max_days      → 'red'
 *   ≤ yellow_max_days   → 'yellow'
 *   それ以外 (Infinity 含む) → 'green'
 */
function classifyTier(stockDays, thresholds) {
  if (stockDays == null) return null;
  if (stockDays <= thresholds.red_max_days) return 'red';
  if (stockDays <= thresholds.yellow_max_days) return 'yellow';
  return 'green';
}

/**
 * 推奨仕入数 = (target + leadTime) × dailyPace − stock、負値は 0 に切り下げ
 * stock=0 の場合、dailyPace=0 の可能性が高い (計算スキップされる) が、
 * 数式定義上は 0 を返す (dailyPace=0 なら必要数不明、既存欠品通知の別軸で扱う)
 */
function calcRecommendedQty(stock, dailyPace, targetDays, leadTimeDays) {
  if (dailyPace == null || dailyPace <= 0) return 0;
  const raw = (targetDays + leadTimeDays) * dailyPace - (stock ?? 0);
  return Math.max(0, Math.ceil(raw));
}

/**
 * データ鮮度判定: lastSyncedAt から warnHours 超過なら false (要警告)
 */
function isFresh(lastSyncedAt, warnHours, now = new Date()) {
  if (!lastSyncedAt) return false;
  const hoursOld = (now.getTime() - new Date(lastSyncedAt).getTime()) / (1000 * 3600);
  return hoursOld <= warnHours;
}

/**
 * SKU が判定対象か。指示書 v2 の絞り込み条件を反映。
 *   除外: crossmallItemCode 未設定 / CROSSMALL マスタ不在 / stock < 0 / 日販=0 かつ stock>0
 *   含める: stock=0 は日販=0 でも 🔴 判定対象
 */
function isEligible(product, dailyPace) {
  if (!product) return false;             // マスタ不在
  if (product.stock < 0) return false;    // 負在庫
  if (product.stock === 0) return true;   // 欠品 (指示: 対象に含める)
  if (dailyPace <= 0) return false;       // 在庫はあるが日販=0 → 判定不可
  return true;
}

/**
 * アラート対象から除外すべき SKU か判定する。
 *   - excluded_sku_codes: crossmallItemCode の完全一致
 *   - excluded_name_keywords: CROSSMALL 商品名 (itemName) の部分文字列一致
 * どちらか一方でも該当すれば除外。
 * 除外はアラート (在庫日数評価・Telegram 通知) にのみ効く。
 * Keyword.isActive とは独立、フリマ (メルカリ/Yahoo) 監視は継続する。
 */
function isExcludedForAlert(skuCode, itemName, cfg) {
  const codes = Array.isArray(cfg?.excluded_sku_codes) ? cfg.excluded_sku_codes : [];
  if (skuCode && codes.includes(skuCode)) return true;
  const kws = Array.isArray(cfg?.excluded_name_keywords) ? cfg.excluded_name_keywords : [];
  if (itemName && kws.length > 0) {
    for (const kw of kws) {
      if (kw && itemName.includes(kw)) return true;
    }
  }
  return false;
}

// ==================== DB アクセス (テストは integration で) ====================

/**
 * 対象 SKU 群の (sales1, sales7, sales14, sales28) を一括集計する。
 * CrossmallSale から orderDate ベースで日次カットを取り、SUM(amount) を返す。
 * 既存 _updateProductStats と同じ day-boundary 方式 (orderDate >= today - N days)。
 *
 * @param {string[]} itemCodes
 * @returns {Promise<Map<string, {sales1, sales7, sales14, sales28}>>}
 */
async function aggregateSalesForCodes(itemCodes) {
  if (!itemCodes || itemCodes.length === 0) return new Map();

  const now = new Date();
  const dayNAgo = (n) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const day1  = dayNAgo(1);
  const day7  = dayNAgo(7);
  const day14 = dayNAgo(14);
  const day28 = dayNAgo(28);

  const rows = await CrossmallSale.findAll({
    attributes: [
      'itemCode',
      [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day1}'  THEN amount ELSE 0 END`)), 'sales1'],
      [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day7}'  THEN amount ELSE 0 END`)), 'sales7'],
      [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day14}' THEN amount ELSE 0 END`)), 'sales14'],
      [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day28}' THEN amount ELSE 0 END`)), 'sales28'],
    ],
    where: {
      itemCode: { [Op.in]: itemCodes },
      orderDate: { [Op.gte]: day28 },
    },
    group: ['itemCode'],
    raw: true,
  });

  const m = new Map();
  for (const r of rows) {
    m.set(r.itemCode, {
      sales1:  parseInt(r.sales1)  || 0,
      sales7:  parseInt(r.sales7)  || 0,
      sales14: parseInt(r.sales14) || 0,
      sales28: parseInt(r.sales28) || 0,
    });
  }
  return m;
}

// ==================== コア処理: 全対象 SKU の評価結果を作る ====================

/**
 * 全 keyword に紐づく SKU を評価し、各 SKU の判定結果を返す。DB 書き込みなし。
 * 呼び出し元: runCheck (履歴更新+通知) / renderDashboard (最新結果表示)
 */
async function evaluateAllSkus(now = new Date()) {
  const kws = await Keyword.findAll({
    where: { isActive: true, crossmallItemCode: { [Op.not]: null } },
    attributes: ['id', 'keyword', 'crossmallItemCode'],
    raw: true,
  });
  const codes = [...new Set(kws.map(k => k.crossmallItemCode).filter(Boolean))];
  if (codes.length === 0) return [];

  const [products, salesMap] = await Promise.all([
    CrossmallProduct.findAll({ where: { itemCode: { [Op.in]: codes } }, raw: true }),
    aggregateSalesForCodes(codes),
  ]);
  const productMap = new Map(products.map(p => [p.itemCode, p]));

  // SKU → 代表 keyword name (先頭 1 件を採用、複数 kw の場合は arbitary)
  const skuToKwName = new Map();
  for (const k of kws) {
    if (!skuToKwName.has(k.crossmallItemCode)) {
      skuToKwName.set(k.crossmallItemCode, k.keyword);
    }
  }

  const results = [];
  for (const code of codes) {
    const product = productMap.get(code);
    // アラート除外リスト (SKU コード完全一致 or 商品名部分一致) は
    // isEligible より前で早期スキップ。Keyword.isActive には触れないので
    // フリマ (メルカリ/Yahoo) 監視は継続する。
    if (isExcludedForAlert(code, product?.itemName, config)) continue;

    const sales = salesMap.get(code) || { sales1: 0, sales7: 0, sales14: 0, sales28: 0 };
    // stock=0 の場合、日販ペース計算はスキップ (指示 v2)
    const stock = product?.stock ?? 0;
    const dailyPace = stock === 0
      ? 0
      : calcDailySalesPace(sales, config.sales_weights);

    if (!isEligible(product, dailyPace)) continue;

    const stockDays = calcStockDaysFromPace(stock, dailyPace);
    const tier = classifyTier(stockDays, config.tier_thresholds);
    const recommendedQty = calcRecommendedQty(
      stock, dailyPace, config.target_stock_days, config.lead_time_days
    );
    const fresh = isFresh(product?.lastSyncedAt, config.freshness_warn_hours, now);

    results.push({
      skuCode: code,
      skuName: skuToKwName.get(code) || code,
      itemName: product?.itemName || null,
      tier,
      stock,
      stockDays,
      dailyPace,
      recommendedQty,
      sales,
      lastSyncedAt: product?.lastSyncedAt || null,
      lastSalePrice: product?.lastSalePrice ?? null,
      lastSaleDate: product?.lastSaleDate || null,
      fresh,
    });
  }
  return results;
}

// ==================== .env / URL 読み取り ====================

/**
 * .env から特定キーの最新値を読み込む (process.env に依存しない、動的更新に対応)
 */
function readEnvValue(key) {
  const envPath = path.join(__dirname, '..', '..', '.env');
  try {
    const text = fs.readFileSync(envPath, 'utf-8');
    const re = new RegExp('^\\s*' + key + '=(.*)$', 'm');
    const m = text.match(re);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
  } catch { return null; }
}

// ==================== Telegram メッセージ組み立て ====================
// 2026-08-27 更新: Telegram 本文は「更新通知 + ダッシュボード URL のみ」の
// 最小フォーマットに簡略化。SKU 詳細・件数・tier 内訳・鮮度警告は本文に
// 含めず、全てダッシュボード側で確認する運用に変更。

// "M/D(曜) H:mm" 形式 (例: 8/27(木) 8:00)。TZ は既存通り Asia/Tokyo を前提。
function formatShortJst(now) {
  const wd = ['日','月','火','水','木','金','土'][now.getDay()];
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${now.getMonth() + 1}/${now.getDate()}(${wd}) ${now.getHours()}:${mm}`;
}

function _dashboardLinkLines(tunnelUrl) {
  if (!tunnelUrl) return [];
  const token = readEnvValue(config.dashboard_token_env);
  const url = `${tunnelUrl}${config.dashboard_path}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  return ['', '▶️ 詳細はこちら', url];
}

// results は現在の本文には出さないが、呼び出し元互換のため引数として保持。
function buildDailyDigestMessage(results, tunnelUrl, now = new Date()) {
  return [
    `📦 在庫アラートを更新しました（${formatShortJst(now)}）`,
    '在庫補充、頑張ってください！',
    ..._dashboardLinkLines(tunnelUrl),
  ].join('\n');
}

// r は現在の本文には出さないが、呼び出し元互換のため引数として保持。
function buildNewlyRedMessage(r, tunnelUrl, now = new Date()) {
  return [
    `🚨 在庫アラートを更新しました（${formatShortJst(now)}）`,
    '在庫補充、頑張ってください！',
    ..._dashboardLinkLines(tunnelUrl),
  ].join('\n');
}

// ==================== HTML ダッシュボード ====================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function renderDashboardHtml(results, generatedAt = new Date()) {
  const reds = results.filter(r => r.tier === 'red');
  const yellows = results.filter(r => r.tier === 'yellow');
  const greens = results.filter(r => r.tier === 'green');

  const fmtPrice = (v) => (v != null && Number.isFinite(v) && v > 0)
    ? `¥${Number(v).toLocaleString('ja-JP')}`
    : '-';
  const fmtDate = (v) => {
    if (!v) return '-';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toISOString().slice(0, 10);
  };

  const renderRow = (r, includeQty) => {
    const name = r.itemName || r.skuName;
    const daysStr = r.stock === 0 ? '残0日 (欠品)' : `残${Math.round(r.stockDays)}日`;
    const qty = includeQty ? `<td class="qty">推奨${r.recommendedQty}個</td>` : '<td></td>';
    const fresh = r.fresh ? '' : '<span class="warn">⚠️4h以上前</span>';
    const priceCell = `<td class="price">${escapeHtml(fmtPrice(r.lastSalePrice))}</td>`;
    const dateCell = `<td class="date">${escapeHtml(fmtDate(r.lastSaleDate))}</td>`;
    return `<tr><td class="name">${escapeHtml(name)} ${fresh}</td><td class="days">${escapeHtml(daysStr)}</td>${qty}${priceCell}${dateCell}<td class="sku">${escapeHtml(r.skuCode)}</td></tr>`;
  };

  const section = (title, rows, includeQty) => {
    if (rows.length === 0) return `<h2>${title}（0件）</h2>`;
    return `<h2>${title}（${rows.length}件）</h2><table><thead><tr><th>商品</th><th>在庫日数</th><th>推奨</th><th>直近販売価格</th><th>最終販売日</th><th>SKU</th></tr></thead><tbody>${rows.map(r => renderRow(r, includeQty)).join('')}</tbody></table>`;
  };

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>ピコフリ2 在庫アラート</title>
<style>
body{font-family:-apple-system,'Hiragino Sans','Yu Gothic',sans-serif;max-width:960px;margin:20px auto;padding:0 12px;line-height:1.5}
h1{border-bottom:2px solid #333;padding-bottom:6px}
h2{margin-top:32px;padding:6px 10px;color:#fff}
h2:has(+ table tr) + table{width:100%;border-collapse:collapse;margin-top:8px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:14px}
th{background:#f4f4f4}
tbody tr:nth-child(odd){background:#fafafa}
.red h2{background:#c0392b}
.yellow h2{background:#e67e22}
.green h2{background:#27ae60}
.warn{color:#e67e22;font-size:12px;margin-left:4px}
.days{white-space:nowrap;font-weight:600}
.qty{white-space:nowrap;color:#2c3e50}
.price{white-space:nowrap;color:#2c3e50;text-align:right}
.date{white-space:nowrap;color:#2c3e50;font-family:monospace;font-size:12px}
.sku{font-family:monospace;font-size:12px;color:#7f8c8d}
.summary{background:#ecf0f1;padding:10px 14px;border-radius:4px}
</style></head><body>
<h1>ピコフリ2 在庫アラート</h1>
<div class="summary">🔴 ${reds.length}件　｜　🟡 ${yellows.length}件　｜　🟢 ${greens.length}件　｜　生成 ${escapeHtml(generatedAt.toLocaleString('ja-JP'))}</div>
<div class="red">${section('🔴 緊急（3日以内）', reds, true)}</div>
<div class="yellow">${section('🟡 注意（4〜13日）', yellows, true)}</div>
<div class="green">${section('🟢 順調（14日以上）', greens, false)}</div>
</body></html>`;
}

// ==================== 履歴更新 + 通知 (runCheck) ====================

class InventoryAlertService {
  // 引数: sendTelegram(message) を持つ任意のオブジェクト (spy 差し替え可)。
  //   省略時は @picofuri_admin_bot 経由の独立 client を作成する。
  //   既存 test は notification オブジェクト (sendTelegram: async fn) を渡す想定、
  //   同じシグネチャなのでそのまま spy 差し替え互換。
  constructor(telegramClient) {
    this.notification = telegramClient || new InventoryAlertTelegramClient();
    // 2026-08-26 レビュー指摘反映: evaluateAllSkus のキャッシュは廃止。
    //   理由: syncAll 間隔 (2h) より TTL が長いと、次の sync 完了データを見落として
    //         古いキャッシュを返す可能性があり「データ鮮度担保」の設計意図と矛盾。
    //         毎回 evaluateAllSkus(now) を直接呼び、DB の最新状態から都度計算する。
    //         200SKU 規模なら 1 クエリ集計 + 純関数群で数百 ms 以下、キャッシュ不要。
  }

  /**
   * 判定 + 履歴更新 + 「新規 🔴 遷移」検知 → リアルタイム Telegram 送信。
   * crossmall.syncAll() 完了直後に呼ばれる想定。毎回フレッシュに評価する。
   *
   * INVENTORY_ALERT_DISABLED=true 設定時は入口で即 return し、履歴更新も評価も
   * 一切行わない (2026-08-26 追加、bot 切り替え作業中の暫定無効化用)。
   */
  async runCheck({ suppressTelegram = false } = {}) {
    if (process.env.INVENTORY_ALERT_DISABLED === 'true') {
      console.log('[InventoryAlert] INVENTORY_ALERT_DISABLED=true: runCheck スキップ');
      return { results: [], newlyReds: [], sentCount: 0, disabled: true };
    }
    const now = new Date();
    const results = await evaluateAllSkus(now);

    // 既存履歴を skuCode → row マップに
    const codes = results.map(r => r.skuCode);
    const historyRows = await InventoryAlertHistory.findAll({
      where: { skuCode: { [Op.in]: codes } },
      raw: true,
    });
    const historyMap = new Map(historyRows.map(h => [h.skuCode, h]));

    const dedupHours = config.realtime_dedup_hours;
    const dedupCutoff = new Date(now.getTime() - dedupHours * 3600 * 1000);
    const tunnelUrl = readEnvValue(config.tunnel_url_env);

    const newlyReds = [];
    for (const r of results) {
      const prev = historyMap.get(r.skuCode);
      const prevTier = prev?.tier;
      const isNewlyRed = r.tier === 'red' && prevTier !== 'red';
      const sentRecently = prev?.lastTelegramSentAt
        && new Date(prev.lastTelegramSentAt) > dedupCutoff;
      if (isNewlyRed && !sentRecently) newlyReds.push(r);
    }

    // Telegram: 新規 🔴 を 1 通に集約して送信
    //   2026-08-27 リンクのみ形式に伴い本文が SKU 非依存になったため、
    //   複数 SKU 同時新規🔴 でも 1 通のみ送信 (通知の煩わしさ低減が趣旨)。
    //   dedup 記録 (lastTelegramSentAt) は全 newlyReds に対して更新する
    //   (1 通の集約通知で全 SKU が「通知済み」扱いになる)。
    let sentCount = 0;
    if (!suppressTelegram && newlyReds.length > 0) {
      try {
        const msg = buildNewlyRedMessage(newlyReds[0], tunnelUrl, now);
        await this.notification.sendTelegram(msg);
        sentCount = 1;
      } catch (e) {
        console.error(`[InventoryAlert] realtime send err (batch of ${newlyReds.length} SKUs): ${e.message}`);
      }
    }

    // 履歴 upsert (全 SKU、送信有無に関わらず tier/checkedAt を更新)
    // 送信された SKU のみ lastTelegramSentAt を更新
    const sentSkuSet = new Set(newlyReds.map(r => r.skuCode));
    for (const r of results) {
      const prev = historyMap.get(r.skuCode);
      await InventoryAlertHistory.upsert({
        skuCode: r.skuCode,
        tier: r.tier,
        stockDays: Number.isFinite(r.stockDays) ? r.stockDays : null,
        checkedAt: now,
        lastTelegramSentAt: sentSkuSet.has(r.skuCode)
          ? now
          : (prev?.lastTelegramSentAt || null),
      });
    }

    console.log(`[InventoryAlert] runCheck: 対象 ${results.length}SKU / 新規🔴 ${newlyReds.length}件 / 送信 ${sentCount}件`);
    return { results, newlyReds, sentCount };
  }

  /**
   * 8:00 日次ダイジェスト。1 メッセージにまとめて送信。
   * 送信直後、digest 本文に実際に名前が載った SKU (= 🔴 のみ) の
   * lastTelegramSentAt を now に更新する。
   *
   * 2026-08-26 レビュー指摘反映:
   *   旧実装は全 SKU (🔴🟡🟢) の lastTelegramSentAt を更新していたため、
   *   digest 本文に名前が出ない 🟡 SKU が後に 🔴 遷移した場合に
   *   dedup 判定でリアルタイム通知がスキップされる致命的バグがあった。
   *   digest に実際に露出した SKU のみを「通知済み」扱いにする。
   */
  async sendDailyDigest() {
    if (process.env.INVENTORY_ALERT_DISABLED === 'true') {
      console.log('[InventoryAlert] INVENTORY_ALERT_DISABLED=true: sendDailyDigest スキップ');
      return { sentCount: 0, disabled: true };
    }
    const now = new Date();
    // キャッシュ廃止 (レビュー指摘反映): 毎回フレッシュに再評価
    const results = await evaluateAllSkus(now);

    const tunnelUrl = readEnvValue(config.tunnel_url_env);
    const msg = buildDailyDigestMessage(results, tunnelUrl, now);
    try {
      await this.notification.sendTelegram(msg);
    } catch (e) {
      console.error(`[InventoryAlert] digest send err: ${e.message}`);
      return { sentCount: 0, error: e.message };
    }

    // 実際に digest 本文に名前が出た 🔴 SKU のみ lastTelegramSentAt を更新
    // (🟡🟢 SKU は本文に登場しないので「通知済み」扱いにしない)
    const notifiedSkus = results.filter(r => r.tier === 'red');
    for (const r of notifiedSkus) {
      const existing = await InventoryAlertHistory.findByPk(r.skuCode);
      if (existing) {
        await existing.update({ lastTelegramSentAt: now });
      }
    }

    console.log(`[InventoryAlert] digest sent: 評価 ${results.length}SKU / 通知済み扱い ${notifiedSkus.length}SKU (🔴のみ)`);
    return { sentCount: 1, resultsCount: results.length, notifiedRedCount: notifiedSkus.length };
  }
}

module.exports = {
  InventoryAlertService,
  InventoryAlertTelegramClient,
  // 純関数 (テスト用に export)
  calcDailySalesPace,
  calcStockDaysFromPace,
  classifyTier,
  calcRecommendedQty,
  isFresh,
  isEligible,
  isExcludedForAlert,
  // 内部関数もテスト対象
  aggregateSalesForCodes,
  evaluateAllSkus,
  buildDailyDigestMessage,
  buildNewlyRedMessage,
  renderDashboardHtml,
  readEnvValue,
};
