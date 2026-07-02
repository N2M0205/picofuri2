const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

puppeteer.use(StealthPlugin());

// 429検出時のサーキットブレーカー用エラー型
// ScrapingService 側で err.name === 'YahooRateLimitError' を判定して本スキャンのYahoo残キーワードを打ち切る
class YahooRateLimitError extends Error {
  constructor(message = 'Yahoo!フリマ rate limit (HTTP 429)') {
    super(message);
    this.name = 'YahooRateLimitError';
  }
}

class YahooScraper {

  async search(keyword) {
    const userDataDir = path.join(os.tmpdir(), `pf2_yahoo_${Date.now()}_${uuidv4().slice(0,8)}`);
    let browser = null;

    try {
      browser = await puppeteer.launch({
        headless: 'new',
        userDataDir: userDataDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process'
        ],
        protocolTimeout: 90000
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
      );

      const searchUrl = `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(keyword)}`;
      const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 早期判定1: HTTP 429（rate limit 応答をpuppeteerが取得できた場合）
      if (response && response.status() === 429) {
        throw new YahooRateLimitError();
      }

      // 早期判定2: rate limit ページのタイトル（HTTPステータスがエラーページで書き換わるケースの保険）
      // 実測（2026-07-02）: 429時に返るページタイトルは
      //   "Yahoo! JAPAN - ご覧になろうとしているページは現在表示できません。"
      const title = await page.title();
      if (title.includes('ご覧になろうとしているページは現在表示できません')) {
        throw new YahooRateLimitError();
      }

      // 早期判定3: 「該当なし」ページマーカー（body textを軽くチェック、waitForSelectorの前に打ち切る）
      // 注: 実際の0件ページ構造は rate limit中で未検証。よく使われる文言を候補列挙。
      // 誤判定リスクを下げるため、body innerText の全文検索でヒットしたら空配列返却。
      // 実運用開始後、誤検出があれば修正する。
      const noResultsMarker = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const markers = [
          '該当する商品が見つかりませんでした',
          '検索結果はありません',
          '検索結果は0件',
          '検索結果 0件',
          '該当する商品はありません',
          '見つかりませんでした',
        ];
        return markers.find(m => body.includes(m)) || null;
      });
      if (noResultsMarker) {
        return [];
      }

      // 商品リンク待ち: 元15秒→5秒に短縮（rate limit / 該当なしはすでに上で早期returnしている想定）
      try {
        await page.waitForSelector('a[href*="/item/"]', { timeout: 5000 });
      } catch {
        console.warn(`[YahooScraper] "${keyword}": 商品セレクタのタイムアウト`);
        return [];
      }

      await new Promise(r => setTimeout(r, 1500));

      const items = await page.evaluate(() => {
        const results = [];
        const links = document.querySelectorAll('a[href*="/item/"]');
        const seen = new Set();

        links.forEach(link => {
          const href = link.href;
          const match = href.match(/\/item\/([a-zA-Z0-9]+)/);
          if (!match || seen.has(match[1])) return;
          seen.add(match[1]);

          // 価格: data-cl-params="...price:NNNN..." 属性から抽出（現行Yahoo!フリマDOM）
          // フォールバックとして class*=price テキストも探す
          let price = 0;
          const params = link.getAttribute('data-cl-params') || '';
          const pm = params.match(/price:(\d+)/);
          if (pm) {
            price = parseInt(pm[1]) || 0;
          } else {
            const priceEl = link.querySelector('[class*="price"], [class*="Price"]');
            const priceText = priceEl?.textContent || '';
            price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
          }

          const titleEl = link.querySelector('img');
          const title = titleEl?.alt || link.getAttribute('aria-label') || '';
          const imgUrl = titleEl?.src || '';

          if (match[1] && price > 0) {
            results.push({
              id: match[1],
              title: title,
              price: price,
              imageUrl: imgUrl,
              itemUrl: href
            });
          }
        });

        return results;
      });

      const listingCount = items.length;
      return items.map(item => ({
        ...item,
        listedAt: null,
        platform: 'yahoo_flea',
        listingCount: listingCount
      }));

    } catch (err) {
      // YahooRateLimitError は上位（ScrapingService）でハンドリングするため再throw
      if (err instanceof YahooRateLimitError) throw err;
      console.error(`[YahooScraper] "${keyword}" エラー: ${err.message}`);
      return [];

    } finally {
      if (browser) {
        try {
          await Promise.race([
            browser.close(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
          ]);
        } catch {
          try {
            const pid = browser.process()?.pid;
            if (pid) process.kill(pid, 'SIGKILL');
          } catch {}
        }
      }
      try {
        if (fs.existsSync(userDataDir)) {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}

module.exports = YahooScraper;
module.exports.YahooRateLimitError = YahooRateLimitError;
