const ngWords = require('../config/ngWords.js');
const layerAConfig = require('../config/layerA.json');
const { FIRST_N_OPT_OUT_KEYWORD_IDS } = require('../config/matchesKeywordFirstNOptOut.js');

// グローバル除外キーワード（可変）
const GLOBAL_EXCLUDE_KEYWORDS = ['空箱', 'サンプル'];

class FilterService {

  // ========== タイトルフィルタ（検索結果の事前絞り込み）==========
  // OR 構文対応 (2026-08-31 追加、feat/matches-keyword-or-syntax、案 B):
  //   Keyword.keyword にカンマ (,) / パイプ (｜/|) 区切りでバリアントを
  //   列挙可。いずれか 1 バリアントが _matchesKeywordSingle を通過すれば pass。
  //   例: "トイラボ,ToyLaBO" → "トイラボ 40ml" または "ToyLaBO 40ml"
  //       のいずれかにマッチ
  //   区切りなしの単一 keyword は従来通り (バリアント 1 個扱いで同挙動)。
  //   空バリアント (連続区切り) は無視。全て空の場合は「空 keyword」扱いで
  //   matches all (従来の空 keyword 挙動を維持)。
  matchesKeyword(title, keyword, opts = {}) {
    const variants = (keyword || '')
      .split(/[,|｜]/)
      .map(s => s.trim())
      .filter(Boolean);
    if (variants.length === 0) {
      // 空 keyword or 区切り記号のみ: 従来の空 keyword 挙動 (matches all)
      return this._matchesKeywordSingle(title, '', opts);
    }
    return variants.some(v => this._matchesKeywordSingle(title, v, opts));
  }

  // 単一 keyword 判定 (旧 matchesKeyword 本体、OR 構文の各バリアント毎に呼ばれる)
  //
  // 全角英数→半角 / 正規化 / AND判定 / フレーズ一致
  //
  // モード決定の優先順位:
  //   1) env MATCHES_KEYWORD_MODE=first-n-tokens が set → 全 tier で first-n
  //      (既存 dry-run/検証用のグローバル override、後方互換)
  //   2) opts.tier === 'cold' AND opts.keywordId が opt-out リストに無い →
  //      first-n-tokens
  //      (2026-07-30 追加、Cold は Mercari 側総ヒット数が少なく AND-full だと
  //       表記ゆれで 0 通過になりがち → 先頭N のみで通過率を上げる)
  //      (2026-08-11 opt-out 追加: 4トークン以上の SKU 群 13キーワードは同じ
  //       先頭3 tokenを共有し attribution 問題を起こすため、and-full を維持)
  //   3) それ以外 (Hot/Warm/StarredOos、opt-out 済み Cold) → and-full
  //      (デフォルト、現状維持)
  //
  //   MATCHES_KEYWORD_FIRST_N=3 (first-n モード時の N、デフォルト 3)
  //
  // 案E-1 の狙い:
  //   Case D 検証で「Mercariは緩い部分マッチ / filter は AND完全一致」の非対称が判明。
  //   短縮 (案A) の後もまだ弾かれ得るケースを救済するため、
  //   先頭N tokenのみを AND対象とし通過率を上げる。
  //   fallback のフレーズ一致は両モードで維持 (安全網)。
  _matchesKeywordSingle(title, keyword, opts = {}) {
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
    // env override > (tier=cold AND opt-out 外) > and-full の優先順位
    const envMode = process.env.MATCHES_KEYWORD_MODE;
    const optedOut = opts.keywordId != null && FIRST_N_OPT_OUT_KEYWORD_IDS.has(opts.keywordId);
    const useFirstN = envMode === 'first-n-tokens' || (opts.tier === 'cold' && !optedOut);
    const firstN = parseInt(process.env.MATCHES_KEYWORD_FIRST_N || '3', 10);
    const wordsToMatch = useFirstN ? words.slice(0, firstN) : words;

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

    // 4. 商品状態 (2026-09-02 追加): Mercari の itemConditionId が "1" (新品、
    //    未使用) 以外なら NG。undefined / null / "" (Yahoo または取得不能) は
    //    fail-open で通過させる (falsy 全般を「取得できず」として扱う)。
    //    Phase1 で予定されつつ未実装だった 3 フィルタのうち、Mercari API 側で
    //    構造化フィールドが取れる商品状態のみ今回実装。
    //    詳細な決定経緯: docs/decisions/2026-09-02-three-filters-implementation.md
    if (item.itemConditionId && item.itemConditionId !== '1') {
      return {
        pass: false,
        reason: `商品状態 NG (itemConditionId="${item.itemConditionId}" / "1"=新品未使用 以外)`
      };
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
