const { SignJWT, generateKeyPair, exportJWK } = require('jose');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

class MercariApiScraper {
  constructor() {
    this.keyPair = null;
    this.publicKeyJwk = null;
    this.initialized = false;
  }

  // 起動時に1回だけ呼ぶ
  async initialize() {
    this.keyPair = await generateKeyPair('ES256');
    this.publicKeyJwk = await exportJWK(this.keyPair.publicKey);
    this.initialized = true;
    console.log('[MercariApiScraper] 初期化完了（DPoP鍵ペア生成済み）');
  }

  // リクエストごとに新しいDPoPトークンを生成
  async _generateDPoP(deviceUuid) {
    return await new SignJWT({
      iat: Math.floor(Date.now() / 1000),
      jti: uuidv4(),
      htu: 'https://api.mercari.jp/v2/entities:search',
      htm: 'POST',
      uuid: deviceUuid
    })
    .setProtectedHeader({
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: this.publicKeyJwk
    })
    .sign(this.keyPair.privateKey);
  }

  async search(keyword) {
    if (!this.initialized) throw new Error('initialize()を先に呼んでください');

    const deviceUuid = uuidv4();
    const searchSessionId = uuidv4().replace(/-/g, '');
    const dpop = await this._generateDPoP(deviceUuid);

    const payload = {
      userId: "",
      config: { responseToggles: ["QUERY_SUGGESTION_WEB_1"] },
      pageSize: 120,
      pageToken: "",
      searchCondition: {
        keyword: keyword,
        excludeKeyword: "",
        sort: "SORT_CREATED_TIME",
        order: "ORDER_DESC",
        status: ["STATUS_ON_SALE"],
        sizeId: [], categoryId: [], brandId: [],
        sellerId: [], priceMin: 0, priceMax: 0,
        itemConditionId: [], shippingPayerId: []
      },
      searchSessionId: searchSessionId,
      laplaceDeviceUuid: deviceUuid,
      serviceFrom: "suruga",
      source: "BaseSerp",
      thumbnailTypes: [],
      useDynamicAttribute: true,
      withAuction: true,
      withItemBrand: true,
      withItemPromotions: true,
      withItemSize: false,
      withItemSizes: true,
      withOfferPricePromotion: true,
      withParentProducts: false,
      withProductArticles: true,
      withProductSuggest: true,
      withSearchConditionId: false,
      withShopname: false,
      withSuggestedItems: true,
      indexRouting: "INDEX_ROUTING_UNSPECIFIED"
    };

    try {
      const response = await axios.post(
        'https://api.mercari.jp/v2/entities:search',
        payload,
        {
          headers: {
            'content-type': 'application/json',
            'dpop': dpop,
            'x-platform': 'web',
            'x-country-code': 'JP',
            'origin': 'https://jp.mercari.com',
            'referer': 'https://jp.mercari.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'ja',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'cross-site'
          },
          timeout: 10000
        }
      );

      const items = response.data.items || [];
      const listingCount = parseInt(response.data.meta?.numFound) || null;

      return items.map(item => ({
        id: item.id,
        title: item.name,
        price: parseInt(item.price) || 0,
        imageUrl: item.thumbnails?.[0] || '',
        itemUrl: `https://jp.mercari.com/item/${item.id}`,
        listedAt: item.created
          ? new Date(parseInt(item.created) * 1000)
          : null,
        status: item.status,
        platform: 'mercari',
        listingCount: listingCount
      }));

    } catch (err) {
      const status = err.response?.status;
      console.error(`[MercariApiScraper] "${keyword}" エラー: ${status || err.message}`);
      if (status === 429) {
        await new Promise(r => setTimeout(r, 5000));
      }
      return [];
    }
  }
}

module.exports = MercariApiScraper;
