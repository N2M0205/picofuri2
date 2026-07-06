const { Keyword } = require('../models');

/**
 * 同一 crossmallItemCode を持つキーワードを1グループとしてまとめて返す。
 * crossmallItemCode が null / 空文字のキーワードは、それぞれ独立した「単独グループ」として扱う。
 *
 * @returns {Promise<Array<{ itemCode: string|null, keywords: Array<Keyword> }>>}
 *   itemCode: 共有itemCode（単独グループの場合 null）
 *   keywords: そのSKUを指すKeywordインスタンス配列（1件以上）
 */
async function getKeywordGroups() {
  const keywords = await Keyword.findAll();
  const byCode = new Map();
  const standalone = [];
  for (const kw of keywords) {
    const code = kw.crossmallItemCode;
    if (code && code.trim() !== '') {
      const key = code.trim();
      if (!byCode.has(key)) byCode.set(key, []);
      byCode.get(key).push(kw);
    } else {
      standalone.push(kw);
    }
  }
  const groups = [];
  for (const [itemCode, kws] of byCode.entries()) {
    groups.push({ itemCode, keywords: kws });
  }
  for (const kw of standalone) {
    groups.push({ itemCode: null, keywords: [kw] });
  }
  return groups;
}

/**
 * 指定 itemCode に紐づくキーワード群を返す。
 * itemCode が falsy / 空文字の場合は空配列。
 *
 * @param {string} itemCode
 * @returns {Promise<Array<Keyword>>}
 */
async function getKeywordsByItemCode(itemCode) {
  if (!itemCode || typeof itemCode !== 'string' || itemCode.trim() === '') return [];
  return await Keyword.findAll({ where: { crossmallItemCode: itemCode.trim() } });
}

/**
 * ユニークSKU（crossmallItemCode）の一覧を返す（null 除外）。
 * @returns {Promise<Array<string>>}
 */
async function listUniqueSkus() {
  const rows = await Keyword.findAll({
    attributes: ['crossmallItemCode'],
    where: { crossmallItemCode: { [require('sequelize').Op.not]: null } },
    raw: true,
  });
  const set = new Set();
  for (const r of rows) {
    const code = (r.crossmallItemCode || '').trim();
    if (code) set.add(code);
  }
  return [...set];
}

module.exports = { getKeywordGroups, getKeywordsByItemCode, listUniqueSkus };
