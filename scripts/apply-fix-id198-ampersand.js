#!/usr/bin/env node
// id=198 のキーワード「スルフォラファン&amp;ギャバの恵み 60粒」を
// 「スルフォラファン&ギャバの恵み 60粒」に修正
//
// 判断根拠 (直近14日 0件検知調査、owner 承認済み):
//   - Mercari 直接検索で `&amp;` (HTML エンティティ) 表記 → 0 件
//   - `&` (単独記号) 表記 → 32 件
//   - キーワード登録時に HTML エンティティが誤って混入したものと判断
//
// 実装: id=198 の keyword 列を書き換え。updatedAt を更新
// 冪等性: 既に修正済みなら no-op
//
// 事前バックアップ:
//   cp database.sqlite database.sqlite.bak_$(date +%Y%m%d_%H%M%S)_before_id198_ampersand

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');

const OLD = 'スルフォラファン&amp;ギャバの恵み 60粒';
const NEW = 'スルフォラファン&ギャバの恵み 60粒';

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const kw = await Keyword.findByPk(198);
  if (!kw) {
    console.error('[fix-id198] id=198 が見つかりません');
    process.exit(1);
  }
  console.log(`[fix-id198] 現在の keyword: "${kw.keyword}"`);
  if (kw.keyword === NEW) {
    console.log('  既に修正済み、何もしない');
    await sequelize.close();
    return;
  }
  if (kw.keyword !== OLD) {
    console.error(`  想定外の keyword 値: "${kw.keyword}" (期待: "${OLD}")、中止`);
    process.exit(1);
  }
  await kw.update({ keyword: NEW });
  console.log(`[fix-id198] 修正完了: "${OLD}" -> "${NEW}"`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
