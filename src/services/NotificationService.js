const axios = require('axios');

class NotificationService {
  constructor() {
    this.token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    this.enabled = process.env.LINE_NOTIFY_ENABLED === 'true';
  }

  async sendLine(message) {
    if (!this.enabled) {
      console.log('[LINE] 送信無効（LINE_NOTIFY_ENABLED=false）');
      return;
    }
    if (!this.token || this.token === 'REPLACE_ME') {
      console.warn('[LINE] トークン未設定');
      return;
    }

    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/broadcast',
        {
          messages: [{ type: 'text', text: message }]
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      console.log('[LINE] 送信成功');
    } catch (err) {
      console.error('[LINE] 送信エラー:', err.response?.status, err.message);
    }
  }

  buildNewItemMessage(item, keyword, profitInfo) {
    const platform = item.platform === 'mercari' ? 'メルカリ' : 'Yahoo!フリマ';
    const priceStr = `¥${item.price.toLocaleString()}`;
    const dateStr = item.listedAt
      ? item.listedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : '不明';

    let msg = [
      `🆕 新着出品【${platform}】`,
      `━━━━━━━━━━━`,
      `商品名: ${item.title}`,
      `価格: ${priceStr}`,
      `出品日時: ${dateStr}`,
      `キーワード: ${keyword}`
    ].join('\n');

    if (profitInfo) {
      const profitStr = profitInfo.profit >= 0
        ? `+¥${profitInfo.profit.toLocaleString()}`
        : `-¥${Math.abs(profitInfo.profit).toLocaleString()}`;
      msg += '\n' + [
        '',
        '💰 利益試算',
        `仕入: ¥${profitInfo.purchasePrice.toLocaleString()}`,
        `手数料: ¥${profitInfo.commission.toLocaleString()}`,
        `利益: ${profitStr}（${profitInfo.margin}%）`
      ].join('\n');
    }

    msg += `\n\n🔗 ${item.itemUrl}`;
    return msg;
  }

  async notifyNewItem(item, keyword, profitInfo) {
    const message = this.buildNewItemMessage(item, keyword, profitInfo);
    console.log(`[通知] ${item.platform} "${item.title}" ¥${item.price}`);
    await this.sendLine(message);
  }
}

module.exports = NotificationService;
