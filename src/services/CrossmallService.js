const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { CrossmallProduct, CrossmallSale, Keyword, sequelize } = require('../models/index.js');

class CrossmallService {
  constructor() {
    this.apiUrl = process.env.CROSSMALL_API_URL;
    this.account = process.env.CROSSMALL_ACCOUNT;
    this.apiKey = process.env.CROSSMALL_API_KEY;
    // 並列起動防止: syncAll / syncOrders どちらの経路でも共通の1本ロック
    // Phase1で起動時setTimeout(syncOrders) と 2h cron(syncAll→syncOrders) が
    // 重複起動していた問題への対策
    this.isSyncing = false;
  }

  // ===== 既存（変更なし）: 署名・HTTPリクエスト =====

  // MD5署名生成（CROSSMALL社の正式仕様）
  // 手順: api_keyを含まないパラメータをkey名でソート→"key=value&..."→末尾に生のAPIキー値を結合→MD5→小文字16進数
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

  // ===== XMLパースヘルパー =====

  // CROSSMALL のレスポンスは <Result No='N'>...</Result> の繰り返し。属性付きタグに対応
  _parseResults(xml) {
    const results = [];
    const re = /<Result\s+No='\d+'>([\s\S]*?)<\/Result>/g;
    let m;
    while ((m = re.exec(xml)) !== null) results.push(m[1]);
    return results;
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

  _hasApiError(xml) {
    return /<GetStatus>error<\/GetStatus>/.test(xml);
  }

  // ===== 在庫取得（マッピング済みSKUを1件ずつクエリ）=====
  // CROSSMALL get_stock の仕様上、item_code/sku_code/jan_code のいずれかが必須。bulk listing不可
  async getStock() {
    const keywords = await Keyword.findAll({
      where: { crossmallItemCode: { [Op.not]: null } },
      attributes: ['crossmallItemCode']
    });
    const codes = [...new Set(keywords.map(k => k.crossmallItemCode).filter(Boolean))];

    console.log(`[CrossmallService] 在庫データ取得中... (${codes.length}SKU)`);
    const result = {};
    for (const code of codes) {
      try {
        const xml = await this._request('get_stock', { item_code: code });
        if (this._hasApiError(xml)) {
          console.warn(`[CrossmallService] get_stock(${code}) API応答エラー`);
          continue;
        }
        // 在庫レスポンス: <Result><item_cd>...<stock>...
        const blocks = this._parseResults(xml);
        blocks.forEach(b => {
          const cd = this._parseXmlTag(b, 'item_cd');
          const stock = parseInt(this._parseXmlTag(b, 'stock')) || 0;
          if (cd) result[cd] = stock;
        });
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        console.warn(`[CrossmallService] get_stock(${code}) 通信エラー:`, e.message);
      }
    }
    console.log(`[CrossmallService] 在庫取得: ${Object.keys(result).length}件`);
    return result;
  }

  // ===== 商品情報取得（get_item, item_name/cost_price/fixed_price）=====
  async getItemInfo(itemCodes) {
    const result = {};
    for (const code of itemCodes) {
      try {
        const xml = await this._request('get_item', { item_code: code });
        if (this._hasApiError(xml)) continue;
        const blocks = this._parseResults(xml);
        if (blocks.length === 0) continue;
        const b = blocks[0];
        const name = this._parseXmlTag(b, 'item_name');
        const purchasePrice = parseInt(this._parseXmlTag(b, 'cost_price')) || 0;
        const retailPrice = parseInt(this._parseXmlTag(b, 'fixed_price')) || 0;
        result[code] = { name, purchasePrice, retailPrice };
        await new Promise(r => setTimeout(r, 200));
      } catch { /* 個別エラーはスキップ */ }
    }
    return result;
  }

  // ===== 注文蓄積（90日分初回 / 差分）=====
  // CROSSMALL の構造: get_order でヘッダ取得 → 各注文に get_order_detail で明細取得（2段階）
  // ページネーション: order_date_fr で範囲指定 + order_number カーソル方式（昇順固定）
  async syncOrders() {
    if (this.isSyncing) {
      console.log('[CrossmallService] syncOrders スキップ（既に同期実行中）');
      return;
    }
    this.isSyncing = true;
    try {
      return await this._syncOrdersImpl();
    } finally {
      this.isSyncing = false;
    }
  }

  async _syncOrdersImpl() {
    const INITIAL_DAYS = 90;
    const MARGIN_DAYS = 2;

    // 最新注文日（CrossmallSaleの最新orderDate）から差分を計算
    const latest = await CrossmallSale.findOne({
      order: [['orderDate', 'DESC']],
      attributes: ['orderDate']
    });
    const today = new Date();
    let fromDate;
    if (!latest) {
      fromDate = new Date(today);
      fromDate.setDate(fromDate.getDate() - INITIAL_DAYS);
      console.log(`[CrossmallService] 初回同期: 過去${INITIAL_DAYS}日分`);
    } else {
      fromDate = new Date(latest.orderDate);
      fromDate.setDate(fromDate.getDate() - MARGIN_DAYS);
      console.log(`[CrossmallService] 差分同期: ${fromDate.toISOString().slice(0,10)}〜`);
    }
    const fromDateStr = fromDate.toISOString().slice(0, 10);

    // 既存注文番号セット（重複スキップ用）
    const existingOrders = new Set(
      (await CrossmallSale.findAll({ attributes: ['orderNumber'] }))
        .map(r => r.orderNumber)
    );

    let cursor = '1';
    let pageCount = 0;
    let savedCount = 0;
    let skippedExisting = 0;
    let skippedCancel = 0;
    let detailErrors = 0;
    const PAGE_LIMIT = 200; // 安全弁

    while (pageCount < PAGE_LIMIT) {
      pageCount++;
      let xml;
      try {
        xml = await this._request('get_order', {
          order_date_fr: fromDateStr,
          order_number: cursor
        });
      } catch (e) {
        console.error(`[CrossmallService] get_order ページ${pageCount} (cursor=${cursor}) 失敗:`, e.message);
        break;
      }

      if (this._hasApiError(xml)) {
        const msg = this._parseXmlTag(xml, 'Message');
        console.warn(`[CrossmallService] get_order APIエラー (cursor=${cursor}): ${msg}`);
        break;
      }

      const orders = this._parseResults(xml);
      if (orders.length === 0) {
        console.log(`[CrossmallService] ページ${pageCount}: 0件 → 終了`);
        break;
      }

      let maxOrderNum = cursor;

      for (const block of orders) {
        const num = this._parseXmlTag(block, 'order_number');
        const dateRaw = this._parseXmlTag(block, 'order_date'); // "2025/03/01 00:03:40"
        const orderDate = dateRaw ? dateRaw.slice(0, 10).replace(/\//g, '-') : null;
        const delivery = this._parseXmlTag(block, 'delivery_type_name');
        const cancelFlag = this._parseXmlTag(block, 'cancel_flag');

        // カーソル更新（数値比較）
        if (num && parseInt(num, 10) > parseInt(maxOrderNum, 10)) maxOrderNum = num;

        if (!num || !orderDate) continue;
        if (cancelFlag === '1') { skippedCancel++; continue; }
        if (existingOrders.has(num)) { skippedExisting++; continue; }

        // 明細取得
        try {
          const detailXml = await this._request('get_order_detail', { order_number: num });
          if (this._hasApiError(detailXml)) {
            detailErrors++;
            continue;
          }
          const details = this._parseResults(detailXml);
          for (const d of details) {
            const itemCode = this._parseXmlTag(d, 'item_code');
            const lineNo = parseInt(this._parseXmlTag(d, 'line_no')) || 1;
            const amount = parseInt(this._parseXmlTag(d, 'amount')) || 1;
            const unitPrice = parseInt(this._parseXmlTag(d, 'unit_price')) || 0;
            const amountPrice = parseInt(this._parseXmlTag(d, 'amount_price')) || 0;
            if (!itemCode) continue;

            await CrossmallSale.upsert({
              orderNumber: num,
              lineNo,
              itemCode,
              orderDate,
              amount,
              unitPrice,
              amountPrice,
              deliveryType: delivery || null
            });
            savedCount++;
          }
          existingOrders.add(num);
          if (savedCount > 0 && savedCount % 100 === 0) {
            console.log(`[CrossmallService] 注文蓄積中... ${savedCount}件`);
          }
          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          detailErrors++;
          console.warn(`[CrossmallService] 明細取得失敗 order=${num}: ${e.message}`);
        }
      }

      // ページネーション: orders < 100 → 最終ページ
      if (orders.length < 100) {
        console.log(`[CrossmallService] ページ${pageCount}: ${orders.length}件 (<100, 最終ページ)`);
        break;
      }
      const nextCursor = String(parseInt(maxOrderNum, 10) + 1);
      if (nextCursor === cursor) {
        console.warn(`[CrossmallService] カーソル前進せず終了 (${cursor})`);
        break;
      }
      cursor = nextCursor;
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[CrossmallService] 注文蓄積完了: page=${pageCount} 新規明細=${savedCount} 既知スキップ=${skippedExisting} cancelスキップ=${skippedCancel} 明細エラー=${detailErrors}`);

    // 90日超レコード削除
    const pruneDate = new Date();
    pruneDate.setDate(pruneDate.getDate() - 90);
    const pruned = await CrossmallSale.destroy({
      where: { orderDate: { [Op.lt]: pruneDate.toISOString().slice(0,10) } }
    });
    if (pruned > 0) console.log(`[CrossmallService] 90日超 ${pruned}件 を削除`);

    await this._updateProductStats();
  }

  // CrossmallSale を集計し CrossmallProduct.sales7/sales28/lastSalePrice/lastSaleDate/deliveryType を更新
  async _updateProductStats() {
    const now = new Date();
    const d7  = new Date(now); d7.setDate(d7.getDate() - 7);
    const d28 = new Date(now); d28.setDate(d28.getDate() - 28);
    const day7  = d7.toISOString().slice(0, 10);
    const day28 = d28.toISOString().slice(0, 10);

    const results = await CrossmallSale.findAll({
      attributes: [
        'itemCode',
        [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day7}' THEN amount ELSE 0 END`)), 'sales7'],
        [sequelize.fn('SUM', sequelize.literal(`CASE WHEN orderDate >= '${day28}' THEN amount ELSE 0 END`)), 'sales28'],
        [sequelize.fn('MAX', sequelize.col('orderDate')), 'lastSaleDate'],
      ],
      where: { orderDate: { [Op.gte]: day28 } },
      group: ['itemCode'],
      raw: true
    });

    for (const row of results) {
      const latest = await CrossmallSale.findOne({
        where: { itemCode: row.itemCode },
        order: [['orderDate', 'DESC'], ['createdAt', 'DESC']]
      });
      await CrossmallProduct.upsert({
        itemCode: row.itemCode,
        sales7: parseInt(row.sales7) || 0,
        sales28: parseInt(row.sales28) || 0,
        lastSaleDate: row.lastSaleDate,
        lastSalePrice: latest?.unitPrice || 0,
        deliveryType: latest?.deliveryType || null,
        lastSyncedAt: now
      });
    }
    console.log(`[CrossmallService] 統計更新完了: ${results.length}SKU`);
  }

  // ===== 全体同期 =====
  async syncAll() {
    if (this.isSyncing) {
      console.log('[CrossmallService] syncAll スキップ（既に同期実行中）');
      return;
    }
    this.isSyncing = true;
    try {
      return await this._syncAllImpl();
    } finally {
      this.isSyncing = false;
    }
  }

  async _syncAllImpl() {
    console.log('[CrossmallService] 同期開始...');
    try {
      // 1. 注文蓄積（CrossmallSale + 統計）
      //    syncAll 内から呼ぶ場合は既に isSyncing=true のため、syncOrders() ではなく
      //    実装本体を直接呼び出す（ダブルガードを回避）
      await this._syncOrdersImpl();

      // 2. 在庫取得（CrossmallProduct.stock）
      const stocks = await this.getStock();
      const stockCodes = Object.keys(stocks);

      // 3. itemNameが未取得のSKUに対して get_item 呼び出し
      const stale = await CrossmallProduct.findAll({
        where: {
          itemCode: { [Op.in]: stockCodes },
          itemName: { [Op.or]: [{ [Op.is]: null }, { [Op.eq]: '' }] }
        },
        attributes: ['itemCode']
      });
      const needInfo = stale.map(r => r.itemCode);
      const itemInfos = needInfo.length ? await this.getItemInfo(needInfo) : {};

      // 4. CrossmallProduct upsert (stock + 情報)
      for (const code of stockCodes) {
        const info = itemInfos[code] || {};
        await CrossmallProduct.upsert({
          itemCode: code,
          stock: stocks[code],
          ...(info.name && { itemName: info.name }),
          ...(info.purchasePrice && { purchasePrice: info.purchasePrice }),
          ...(info.retailPrice && { retailPrice: info.retailPrice }),
          lastSyncedAt: new Date()
        });
      }

      console.log('[CrossmallService] 同期完了');
    } catch (err) {
      console.error('[CrossmallService] 同期エラー:', err.message);
    }
  }

  // ===== キーワード→商品検索 =====
  // 優先: keyword.crossmallItemCode（明示マッピング）→ itemName 部分一致
  async findProductByKeyword(keywordOrObj) {
    if (typeof keywordOrObj === 'object' && keywordOrObj?.crossmallItemCode) {
      const p = await CrossmallProduct.findOne({ where: { itemCode: keywordOrObj.crossmallItemCode } });
      if (p) return p;
    }
    const keyword = typeof keywordOrObj === 'string' ? keywordOrObj : keywordOrObj?.keyword;
    if (!keyword) return null;
    const products = await CrossmallProduct.findAll();
    return products.find(p => p.itemName && p.itemName.includes(keyword)) || null;
  }

  // 旧Phase0用の素朴な利益計算（NotificationServiceで上書きされるため後方互換のみ）
  calcProfit(listedPrice, purchasePrice) {
    if (!purchasePrice || purchasePrice <= 0) return null;
    const commission = Math.floor(listedPrice * 0.1);
    const profit = listedPrice - commission - purchasePrice;
    const margin = Math.round((profit / listedPrice) * 100);
    return { profit, margin, commission, purchasePrice };
  }
}

module.exports = CrossmallService;
