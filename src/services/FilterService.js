const ngWords = require('../config/ngWords.js');
const layerAConfig = require('../config/layerA.json');

// グローバル除外キーワード（可変）
const GLOBAL_EXCLUDE_KEYWORDS = ['空箱', 'サンプル'];

class FilterService {

  // ========== タイトルフィルタ（検索結果の事前絞り込み）==========
  // 全角英数→半角 / 正規化 / AND判定 / フレーズ一致
  //
  // モード切替 (env var):
  //   MATCHES_KEYWORD_MODE=and-full        (デフォルト、現状維持: 有効tokenを全 AND判定)
  //   MATCHES_KEYWORD_MODE=first-n-tokens  (先頭N tokenのみAND判定、案E-1)
  //   MATCHES_KEYWORD_FIRST_N=3            (first-n-tokens モード時のN、デフォルト3)
  //
  // 案E-1 の狙い:
  //   Case D 検証で「Mercariは緩い部分マッチ / filter は AND完全一致」の非対称が判明。
  //   短縮 (案A) の後もまだ弾かれ得るケースを救済するため、
  //   先頭N tokenのみを AND対象とし通過率を上げる。
  //   fallback のフレーズ一致は両モードで維持 (安全網)。
  matchesKeyword(title, keyword) {
    const normalize = str => str
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[+＋]/g, 'プラス')
      .replace(/[^\w぀-ヿ一-鿿　-〿 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const STOP_WORDS = ['no', 'the', 'for', 'and', 'with', 'from', 'de', 'la', 'le'];

    const normTitle   = normalize(title);
    const normKeyword = normalize(keyword);

    // 有効ワード抽出（機能語除外）
    const words = normKeyword.split(/\s+/).filter(w => w && !STOP_WORDS.includes(w));
    if (words.length === 0) return true;

    // モード判定
    const mode = process.env.MATCHES_KEYWORD_MODE || 'and-full';
    const firstN = parseInt(process.env.MATCHES_KEYWORD_FIRST_N || '3', 10);
    const wordsToMatch = mode === 'first-n-tokens' ? words.slice(0, firstN) : words;

    // AND判定 (モードに応じた対象トークン)
    if (wordsToMatch.every(w => normTitle.includes(w))) return true;

    // フレーズ一致（スペース除去後、両モードで安全網）
    const phraseTitle   = normTitle.replace(/\s/g, '');
    const phraseKeyword = normKeyword.replace(/\s/g, '');
    if (phraseTitle.includes(phraseKeyword)) return true;

    return false;
  }

  // ========== LayerA フィルタ ==========
  // 戻り値: { pass: boolean, reason: string | null }
  check(item, keyword) {
    const price = item.price;
    const title = (item.title || '').toLowerCase();
    const listedAt = item.listedAt;
    const platform = item.platform;

    // 1. 下限価格
    if (keyword.minPrice > 0 && price < keyword.minPrice) {
      return { pass: false, reason: `下限価格未満 (¥${price} < ¥${keyword.minPrice})` };
    }

    // 1.5 上限価格
    if (keyword.maxPrice < 999999 && price > keyword.maxPrice) {
      return { pass: false, reason: `上限価格超過 (¥${price} > ¥${keyword.maxPrice})` };
    }

    // 3. 出品経過時間（Yahooはタイムスタンプ取得不可のためスキップ）
    if (listedAt) {
      const hoursOld = (Date.now() - new Date(listedAt).getTime()) / (1000 * 3600);
      if (hoursOld > layerAConfig.layer_a_max_hours) {
        return {
          pass: false,
          reason: `出品経過時間超過 (${Math.round(hoursOld)}h > ${layerAConfig.layer_a_max_hours}h)`
        };
      }
    } else if (platform === 'yahoo_flea') {
      // Yahoo!フリマはlistedAt取得不可のためスキップしない
    }

    // 5. NG語句
    for (const word of ngWords) {
      if (title.includes(word.toLowerCase())) {
        return { pass: false, reason: `NG語句検出: "${word}"` };
      }
    }

    // 6. グローバル除外キーワード
    if (keyword.globalExcludeEnabled !== false) {
      for (const word of GLOBAL_EXCLUDE_KEYWORDS) {
        if (title.includes(word.toLowerCase())) {
          return { pass: false, reason: `全体除外: "${word}"` };
        }
      }
    }

    // 6.5. キーワード個別除外
    const individualExcludes = (keyword.excludeKeywords || '')
      .split(',').map(w => w.trim()).filter(Boolean);
    for (const word of individualExcludes) {
      if (title.includes(word.toLowerCase())) {
        return { pass: false, reason: `個別除外: "${word}"` };
      }
    }

    return { pass: true, reason: null };
  }

  // 過剰在庫スキップ（在庫日数 > 25日）
  isOverstock(stock, sales28) {
    if (!sales28 || sales28 === 0) return false; // 売上0は欠品の可能性→スキップしない
    const stockDays = Math.round(stock / (sales28 / 28));
    return stockDays > layerAConfig.layer_a_skip_stock_days;
  }
}

module.exports = FilterService;
