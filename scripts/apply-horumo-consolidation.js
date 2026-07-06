#!/usr/bin/env node
// ホルモ プレミアム 二重登録の統合 (idempotent 冪等スクリプト)
//
// 背景:
//   SKUマッピング一括登録時、CROSSMALL master「ホルモ プレミアム ヘアー グロウ
//   エッセンス 80ml HORMO」(itemCode=2314-001596, 育毛剤側の正しいSKU) を新規
//   キーワードとして追加した (id=218)。
//   一方、既存の id=10「ホルモ プレミアム」は BACKLOG 記載の「複合ヒット
//   (育毛剤 vs サプリメント)」既知バグの対象で crossmallItemCode=null のままだった。
//
//   一晩稼働分析 (P4) との照合により、2314-001596 は id=10 の複合ヒット問題で
//   混入していた育毛剤側の実体である (別実体ではない) と確定。
//
// 案2を採用: id=10 の keyword 文字列を「ホルモ プレミアム 80ml」に絞り込み、
//   crossmallItemCode を 2314-001596 に統一し、id=218 (重複) を削除する。
//   platforms は id=10 のまま [mercari, yahoo_flea] を維持 (Yahoo 復帰時にも動作)。
//
// なお、サプリメント側の正しい SKU は今回未特定。BACKLOG「ホルモ プレミアム:
// 複合ヒット」項目に「育毛剤側 = 2314-001596 特定済 / サプリ側 = 未特定」として
// 継続追跡する。
//
// 冪等性: 既に統合済みの状態で再実行しても副作用なし (「既に統合済」ログのみ)。

'use strict';

require('dotenv').config();
const { Op } = require('sequelize');
const { sequelize, Keyword } = require('../src/models');

const TARGET_ID = 10;
const NEW_KEYWORD = 'ホルモ プレミアム 80ml';
const TARGET_CODE = '2314-001596';

async function main() {
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const kw10 = await Keyword.findByPk(TARGET_ID);
  if (!kw10) {
    console.error(`[horumo] id=${TARGET_ID} が存在しません。処理中断`);
    process.exit(1);
  }

  const already = kw10.keyword === NEW_KEYWORD && kw10.crossmallItemCode === TARGET_CODE;
  if (already) {
    console.log(`[horumo] id=${TARGET_ID} は既に統合済み: keyword="${kw10.keyword}" code=${kw10.crossmallItemCode}`);
  } else {
    console.log(`[horumo] id=${TARGET_ID} 更新: "${kw10.keyword}" / ${kw10.crossmallItemCode || 'null'} -> "${NEW_KEYWORD}" / ${TARGET_CODE}`);
    await kw10.update({ keyword: NEW_KEYWORD, crossmallItemCode: TARGET_CODE });
  }

  // 重複キーワードの削除 (id=218 に限定せず crossmallItemCode ベースで冪等)
  const duplicates = await Keyword.findAll({
    where: {
      crossmallItemCode: TARGET_CODE,
      id: { [Op.ne]: TARGET_ID },
    },
  });
  if (duplicates.length === 0) {
    console.log('[horumo] 削除対象の重複キーワードなし');
  } else {
    for (const d of duplicates) {
      console.log(`[horumo] 重複削除: id=${d.id} "${d.keyword}" code=${d.crossmallItemCode}`);
      await d.destroy();
    }
  }

  const total = await Keyword.count();
  console.log(`[horumo] 完了。Keyword 総数: ${total}`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
