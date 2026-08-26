#!/usr/bin/env node
// id=189 「Ｎ organic」に excludeKeywords 「Owen,Unbranded,Grown,Tee」を追加
//
// 判断根拠 (2026-08-11 案A opt-out 実装時に判明):
//   id=189 は first-n=3 で「n AND organic」判定 (opt-out 対象外)。
//   2 token しかないため実質「n と organic を含む任意タイトル」に広く一致し、
//   restart 後 40分の間に以下 2件を誤検知:
//     - "Mila Owen organics Tシャツ ホワイト" (Owen ブランド T シャツ)
//     - "Unbranded ... Locally Grown Organic Graphic Tee L" (無銘 T シャツ)
//   両方とも本来無関係の Tシャツ商品。
//
// 検証済み事項 (dry-run):
//   - ライブ検索 97件中、追加語 4件のいずれかに hit するのは上記 2件のみ
//   - 過去 DB 614レコード中も同じ 2件しか hit しない
//   - 正規 N organic 商品への false-negative は発生しない
//
// 実装: id=189 の excludeKeywords 列を "" → "Owen,Unbranded,Grown,Tee" に更新
// 冪等性: 既に同じ値が入っていれば no-op
//
// 事前バックアップ:
//   cp database.sqlite database.sqlite.bak_$(date +%Y%m%d_%H%M%S)_before_id189_exclude

'use strict';

require('dotenv').config();
const { sequelize, Keyword } = require('../src/models');

const NEW_EXCLUDE = 'Owen,Unbranded,Grown,Tee';

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');
  const kw = await Keyword.findByPk(189);
  if (!kw) {
    console.error('[id189-exclude] id=189 が見つかりません');
    process.exit(1);
  }
  console.log(`[id189-exclude] 現在: keyword="${kw.keyword}" exclude="${kw.excludeKeywords}"`);
  if (kw.excludeKeywords === NEW_EXCLUDE) {
    console.log('  既に同じ値、no-op');
    await sequelize.close();
    return;
  }
  if (kw.excludeKeywords !== '' && kw.excludeKeywords !== null) {
    console.error(`  想定外の既存値: "${kw.excludeKeywords}" (期待: "" or "${NEW_EXCLUDE}")、中止`);
    process.exit(1);
  }
  await kw.update({ excludeKeywords: NEW_EXCLUDE });
  console.log(`[id189-exclude] 更新完了: excludeKeywords="" -> "${NEW_EXCLUDE}"`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
