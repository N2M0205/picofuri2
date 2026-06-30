const axios = require('axios');
const crypto = require('crypto');
const { CrossmallProduct } = require('../models/index.js');

class CrossmallService {
  constructor() {
    this.apiUrl = process.env.CROSSMALL_API_URL;
    this.account = process.env.CROSSMALL_ACCOUNT;
    this.apiKey = process.env.CROSSMALL_API_KEY;
  }

  // MD5署名生成（CROSSMALL社の正式仕様）
  // 手順: api_keyを含まないパラメータをkey名でソート→"key=value&..."→末尾に生のAPIキー値を結合→MD5→小文字16進数
  // ※api_keyはリクエストパラメータとしても一切送信しない（署名計算にのみ使う）
  _generateSigning(params) {
    const sorted = Object.keys(params)
      .sort()
      .map(k => `${k}=${encodeURIComponent(params[k])}`)
      .join('&');
    return crypto.createHash('md5').update(sorted + this.apiKey).digest('hex');
  }

  async _request(endpoint, params) {
    const allParams = {
      account: this.account,
      ...params
    };
    const signing = this._generateSigning(allParams);

    const queryString = Object.entries(allParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${this.apiUrl}/${endpoint}?${queryString}&signing=${signing}`;

    try {
      const response = await axios.get(url, {
        timeout: 30000,
        responseType: 'text'
      });
      return response.data;
    } catch (err) {
      console.error(`[CrossmallService] ${endpoint} エラー: ${err.message}`);
      throw err;
    }
  }

  _parseXml(xml, tagName) {
    const results = [];
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 'gs');
    let match;
    while ((match = regex.exec(xml)) !== null) {
      results.push(match[1]);
    }
    return results;
  }

  _parseXmlTag(block, tagName) {
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 's');
    const match = block.match(regex);
    return match ? match[1].trim() : '';
  }

  async getStock() {
    console.log('[CrossmallService] 在庫データ取得中...');
    const xml = await this._request('get_stock', {
      condition: 'all'
    });

    const items = this._parseXml(xml, 'item');
    const result = {};
    items.forEach(item => {
      const code = this._parseXmlTag(item, 'item_code');
      const stock = parseInt(this._parseXmlTag(item, 'quantity')) || 0;
      if (code) result[code] = stock;
    });

    console.log(`[CrossmallService] 在庫取得: ${Object.keys(result).length}件`);
    return result;
  }

  async getRecentOrders() {
    console.log('[CrossmallService] 売上データ取得中...');
    const xml = await this._request('get_order', {
      order_number: '1'
    });

    const orders = this._parseXml(xml, 'order');
    const salesByCode = {};

    const now = Date.now();
    const day7  = now - 7  * 24 * 3600 * 1000;
    const day14 = now - 14 * 24 * 3600 * 1000;
    const day28 = now - 28 * 24 * 3600 * 1000;

    orders.forEach(order => {
      const dateStr = this._parseXmlTag(order, 'order_date');
      const orderTime = new Date(dateStr).getTime();
      const details = this._parseXml(order, 'detail');

      details.forEach(detail => {
        const code = this._parseXmlTag(detail, 'item_code');
        const qty  = parseInt(this._parseXmlTag(detail, 'quantity')) || 0;
        if (!code) return;

        if (!salesByCode[code]) salesByCode[code] = { s7: 0, s14: 0, s28: 0 };
        if (orderTime >= day28) salesByCode[code].s28 += qty;
        if (orderTime >= day14) salesByCode[code].s14 += qty;
        if (orderTime >= day7)  salesByCode[code].s7  += qty;
      });
    });

    return salesByCode;
  }

  async getItemInfo(itemCodes) {
    const result = {};
    for (let i = 0; i < itemCodes.length; i += 10) {
      const batch = itemCodes.slice(i, i + 10);
      for (const code of batch) {
        try {
          const xml = await this._request('get_item', { item_code: code });
          const name = this._parseXmlTag(xml, 'item_name');
          const price = parseInt(this._parseXmlTag(xml, 'cost_price')) || 0;
          const retail = parseInt(this._parseXmlTag(xml, 'fixed_price')) || 0;
          result[code] = { name, purchasePrice: price, retailPrice: retail };
          await new Promise(r => setTimeout(r, 200));
        } catch {
          // 個別エラーはスキップ
        }
      }
    }
    return result;
  }

  async syncAll() {
    console.log('[CrossmallService] 同期開始...');
    try {
      const stocks = await this.getStock();
      const sales = await this.getRecentOrders();
      const itemCodes = Object.keys(stocks);

      const existingCodes = (await CrossmallProduct.findAll({
        attributes: ['itemCode']
      })).map(r => r.itemCode);
      const newCodes = itemCodes.filter(c => !existingCodes.includes(c));
      const itemInfos = newCodes.length > 0 ? await this.getItemInfo(newCodes) : {};

      for (const code of itemCodes) {
        const s = sales[code] || { s7: 0, s14: 0, s28: 0 };
        const info = itemInfos[code] || {};
        await CrossmallProduct.upsert({
          itemCode: code,
          stock: stocks[code],
          sales7: s.s7, sales14: s.s14, sales28: s.s28,
          ...(info.name && { itemName: info.name }),
          ...(info.purchasePrice && { purchasePrice: info.purchasePrice }),
          ...(info.retailPrice && { retailPrice: info.retailPrice }),
          lastSyncedAt: new Date()
        });
      }

      console.log(`[CrossmallService] 同期完了: ${itemCodes.length}件`);
    } catch (err) {
      console.error('[CrossmallService] 同期エラー:', err.message);
    }
  }

  async findProductByKeyword(keyword) {
    const products = await CrossmallProduct.findAll();
    return products.find(p =>
      p.itemName && p.itemName.includes(keyword)
    ) || null;
  }

  calcProfit(listedPrice, purchasePrice) {
    if (!purchasePrice || purchasePrice <= 0) return null;
    const commission = Math.floor(listedPrice * 0.1);
    const profit = listedPrice - commission - purchasePrice;
    const margin = Math.round((profit / listedPrice) * 100);
    return { profit, margin, commission, purchasePrice };
  }
}

module.exports = CrossmallService;
