const axios = require('axios');
const { getShippingCost } = require('../config/shippingCost.js');

class NotificationService {
  constructor() {
    this.lineToken      = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    this.lineEnabled    = process.env.LINE_NOTIFY_ENABLED === 'true';
    this.telegramToken  = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_ADMIN_ID;
    this.telegramEnabled = process.env.TELEGRAM_NOTIFY_ENABLED === 'true';
  }

  // ===== 判定ラベル =====
  calcJudgement(profitRate, sales7, stockDays, isRare) {
    if (profitRate > 60)  return '⚠️ 利益率確認';
    if (profitRate <= -50) return '⚠️ 個数確認';
    if (profitRate < 0)   return '❌ 赤字';
    if (profitRate <= 5)  return '❌ 利益なし';
    if (profitRate < 12)  return '❌ 利益薄い';
    if (profitRate >= 12 && stockDays !== Infinity && stockDays <= 7) return '🚨 緊急仕入';
    if (profitRate >= 30 && sales7 >= 3) return '💎 高利益';
    if (profitRate >= 20 && sales7 >= 3 && stockDays <= 14) return '✅ 即買い';
    if (isRare) return '🔥 レア即買';
    if (sales7 <= 2) return '🤔 売行鈍い';
    return '🤔 要検討';
  }

  // ===== 在庫日数 =====
  calcStockDays(stock, sales28) {
    if (stock === 0) return 0;
    if (!sales28 || sales28 === 0) return Infinity;
    return Math.round(stock / (sales28 / 28));
  }

  // ===== 上限仕入価格 =====
  calcPurchaseLimit(lastSalePrice, shippingCost) {
    if (!lastSalePrice || lastSalePrice <= 0) return null;
    if (lastSalePrice <= 3000) {
      return Math.round(lastSalePrice * 0.9 - shippingCost - 300);
    }
    return Math.round(lastSalePrice * 0.78 - shippingCost);
  }

  // ===== 利益計算 =====
  calcProfit(lastSalePrice, shippingCost, fleaPrice) {
    if (!lastSalePrice || lastSalePrice <= 0) return null;
    const profit = Math.round(lastSalePrice * 0.9 - shippingCost - fleaPrice);
    const profitRate = (profit / lastSalePrice) * 100;
    return { profit, profitRate: Math.round(profitRate * 10) / 10 };
  }

  // ===== 出品レア度 =====
  calcRarity(listingCount) {
    if (listingCount == null) return '取得不能';
    if (listingCount <= 2) return '🔥 レア';
    if (listingCount <= 7) return '普通';
    return '多い';
  }

  // ===== メッセージ構築 =====
  buildMessage(item, keyword, product) {
    // CROSSMALL情報
    const stock         = product?.stock ?? 0;
    const sales28       = product?.sales28 ?? 0;
    const sales7        = product?.sales7 ?? 0;
    const lastSalePrice = product?.lastSalePrice ?? 0;
    const deliveryType  = product?.deliveryType ?? null;
    const lastSaleDate  = product?.lastSaleDate ?? null;

    const shippingCost  = getShippingCost(deliveryType);
    const stockDays     = this.calcStockDays(stock, sales28);
    const purchaseLimit = this.calcPurchaseLimit(lastSalePrice, shippingCost);
    const profitResult  = this.calcProfit(lastSalePrice, shippingCost, item.price);
    const profitRate    = profitResult?.profitRate ?? 0;
    const isRare        = (item.listingCount ?? 99) <= 2;

    const judgement = lastSalePrice > 0
      ? this.calcJudgement(profitRate, sales7, stockDays, isRare)
      : '📋 参考';

    // 日付表示
    const lastSaleDateStr = lastSaleDate
      ? `${new Date(lastSaleDate).getMonth() + 1}/${new Date(lastSaleDate).getDate()}`
      : '不明';

    const stockDaysStr = stockDays === Infinity ? '∞' : `約${stockDays}日`;
    const rarityLabel = this.calcRarity(item.listingCount);

    // 価格ライン
    const priceStr = `¥${item.price.toLocaleString()}`;

    // 利益ライン
    let profitLine = '';
    if (profitResult && lastSalePrice > 0) {
      const sign = profitResult.profit >= 0 ? '+' : '';
      const profitIcon = profitResult.profit >= 0 ? '✅' : '⚠️';
      profitLine = `${profitIcon} 利益見込み ${sign}¥${profitResult.profit.toLocaleString()}（送料¥${shippingCost}）利益率${profitResult.profitRate}%`;
    }

    // CROSSMALLライン
    const crossmallLine = product
      ? `📦 在庫${stock}個 | 28日${sales28}個 | 7日${sales7}個 | 最終${lastSaleDateStr}`
      : '📦 在庫情報なし';

    const stockDaysLine = `📅 在庫日数: ${stockDaysStr}`;
    const rarityLine    = `🔥 出品レア度: ${rarityLabel}（${item.listingCount ?? '?'}件）`;

    const priceLine = purchaseLimit !== null
      ? `💰 直近販売¥${lastSalePrice.toLocaleString()} | 上限仕入¥${purchaseLimit.toLocaleString()}`
      : '';

    const lines = [
      judgement,
      '',
      `🛒 ${item.title}`,
      priceStr,
      `🔗 ${item.itemUrl}`,
      '',
      crossmallLine,
      stockDaysLine,
      rarityLine,
      ...(priceLine ? [priceLine] : []),
      ...(profitLine ? [profitLine] : []),
    ];

    return lines.join('\n');
  }

  // ===== 送信メソッド =====

  async sendTelegram(message) {
    if (!this.telegramEnabled) return;
    if (!this.telegramToken || !this.telegramChatId) return;

    // Telegram は4096文字制限。安全側で4000ずつ分割
    const chunks = [];
    for (let i = 0; i < message.length; i += 4000) {
      chunks.push(message.slice(i, i + 4000));
    }

    for (const chunk of chunks) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
          { chat_id: this.telegramChatId, text: chunk },
          { timeout: 10000 }
        );
      } catch (e) {
        console.error('[Telegram] 送信エラー:', e.response?.status, e.message);
      }
    }
  }

  async sendLine(message) {
    if (!this.lineEnabled) return;
    if (!this.lineToken || this.lineToken === 'REPLACE_ME') return;
    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/broadcast',
        { messages: [{ type: 'text', text: message }] },
        {
          headers: {
            Authorization: `Bearer ${this.lineToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
    } catch (e) {
      console.error('[LINE] 送信エラー:', e.response?.status, e.message);
    }
  }

  async notifyNewItem(item, keyword, product) {
    const message = this.buildMessage(item, keyword, product);
    console.log(`[通知] ${item.platform} "${(item.title||'').slice(0,30)}" ¥${item.price}`);
    await this.sendTelegram(message);
    await this.sendLine(message);
  }
}

module.exports = NotificationService;
