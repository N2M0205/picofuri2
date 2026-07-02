/**
 * Win版71キーワードのピコフリ2への移行スクリプト
 *
 * 実行:
 *   DRY_RUN=1 node scripts/migrate-win-keywords.js   # 変更なし・レポートのみ
 *   node scripts/migrate-win-keywords.js             # 実書き込み
 *
 * ポリシー（オーナー確認済み 2026-07-01）:
 *  1. keyword文字列一致でupsert（既存があれば更新、なければ新規）
 *  2. 同SKU短縮バリアント（ルックルック イヌリン / 尿酸と脂肪）は新規挿入、既存は保持
 *  3. platforms は ['mercari','yahoo_flea'] を全新規行のデフォルト
 *  4. Win#10 デオエース 40ml: 既存itemCode=2314-001070 を維持、min/max のみ更新
 *     Win#46 エティアキシル: 5桁ITEMCODE疑いのため crossmallItemCode=null で新規挿入
 *  5. Win#5 risou no Coffee 30 は「無効」で移行対象外（スキップ）
 */

const { Keyword, sequelize } = require('../src/models');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const DEFAULT_PLATFORMS = ['mercari', 'yahoo_flea'];

// Win版71件（オーナー提供の picofuri-audit.md 相当データ）
// itemCode: null は「登録なし」または「既知の桁数エラーで登録保留」
const WIN_KEYWORDS = [
  { row: 1,  keyword: 'ルックルック イヌリン',              itemCode: '2314-000192',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 2,  keyword: 'オキシカット',                        itemCode: '2314-001246',  minPrice: 2800, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 3,  keyword: 'トイラボ',                            itemCode: '2314-001346',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 4,  keyword: 'ToyLaBO',                             itemCode: '2314-001346',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 5,  keyword: 'risou no Coffee 30',                  itemCode: '2314-001811',  minPrice: 1000, maxPrice: 10000,  excludeKeywords: '',           isActive: false },
  { row: 6,  keyword: 'レムウェル 180',                      itemCode: '2314-001867',  minPrice: 2000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 7,  keyword: 'WiQo',                                itemCode: null,           minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 8,  keyword: '尿酸と脂肪',                          itemCode: '2314-001848',  minPrice: 1000, maxPrice: 20000,  excludeKeywords: '',           isActive: true },
  { row: 9,  keyword: 'アルマダ 1000ml',                     itemCode: '2314-000278',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  // #10: Win版原データは 2314-0001070 (5桁で誤り)。既存DBは 2314-001070 (正) を保持
  { row: 10, keyword: 'デオエース 40ml',                     itemCode: null,           minPrice: 1000, maxPrice: 10000,  excludeKeywords: '',           isActive: true, note: 'Win原データitemCode=2314-0001070(桁数エラー)。既存正コード維持、min/maxのみ更新' },
  { row: 11, keyword: '野草酵素',                            itemCode: '2314-001325',  minPrice: 5000, maxPrice: 999999, excludeKeywords: '顆粒,ジェイ', isActive: true },
  { row: 12, keyword: 'SENOPPY CHEWABLE',                    itemCode: '2314-001247',  minPrice: 4000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 13, keyword: 'セノッピー チュアブル',               itemCode: '2314-001247',  minPrice: 4000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 14, keyword: 'ワンデイ クレンズ',                   itemCode: '2314-000519',  minPrice: 4200, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 15, keyword: 'デオエース 20ml',                     itemCode: '2314-000835',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 16, keyword: 'アレルナイト',                        itemCode: '2314-001441',  minPrice: 2000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 17, keyword: 'テルビーナ',                          itemCode: '2314-001572',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 18, keyword: '養宝珠 90粒',                         itemCode: '2314-001830',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 19, keyword: 'スラヘル',                            itemCode: '2314-001895',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 20, keyword: '黄金まゆの絹粉',                      itemCode: '2314-001351',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 21, keyword: 'レムウェル 90',                       itemCode: '2314-001333',  minPrice: 1000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 22, keyword: 'パクパク酵母くん',                    itemCode: '2314-001330',  minPrice: 4000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 23, keyword: '& wolf 002',                          itemCode: '2314-001180',  minPrice: 1000, maxPrice: 5000,   excludeKeywords: 'アイカラー', isActive: true },
  { row: 24, keyword: 'dr365 30ml',                          itemCode: '2314-001216',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 25, keyword: 'ヘパリーゼ 30',                       itemCode: '2314-001057',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: 'W',          isActive: true },
  { row: 26, keyword: 'アポバスター',                        itemCode: '2314-001646',  minPrice: 2000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 27, keyword: 'ノンリ 62粒',                         itemCode: '2314-001645',  minPrice: 4500, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 28, keyword: 'suiso bijin',                         itemCode: '2314-001030',  minPrice: 5000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 29, keyword: '八酵麗茶',                            itemCode: '2314-001324',  minPrice: 7000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 30, keyword: 'セノッピー',                          itemCode: '2314-000521',  minPrice: 1900, maxPrice: 99999,  excludeKeywords: 'チュアブル', isActive: true },
  { row: 31, keyword: 'プルースト　クリーム',            itemCode: '2314-000752',  minPrice: 2800, maxPrice: 99999,  excludeKeywords: '2.0',        isActive: true },
  { row: 32, keyword: 'シズカゲル',                          itemCode: '2314-000614',  minPrice: 1000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 33, keyword: 'ファンガ ソープ',                     itemCode: '2314-001350',  minPrice: 4000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 34, keyword: 'スパルト T5',                         itemCode: '2314-001249',  minPrice: 7000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 35, keyword: 'テストコア NO 3',                     itemCode: '2314-001157',  minPrice: 8000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 36, keyword: 'ぽろぽろとれる 杏',                   itemCode: '2314-001328',  minPrice: 2000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 37, keyword: 'インナーシグナル オールインワン',     itemCode: '2314-001016',  minPrice: 6000, maxPrice: 7500,   excludeKeywords: '包',         isActive: true },
  { row: 38, keyword: 'さかな暮らし',                        itemCode: '2314-001235',  minPrice: 1800, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 39, keyword: 'アルマダ　200ml',                 itemCode: '2314-001347',  minPrice: 2500, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 40, keyword: 'りそうのコーヒー',                    itemCode: '2314-001811',  minPrice: 3000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 41, keyword: 'チャップアップ',                      itemCode: '2314-001844',  minPrice: 2000, maxPrice: 99999,  excludeKeywords: 'サプリ,ビオルチア', isActive: true },
  { row: 42, keyword: 'ラブリービー',                        itemCode: '2314-001265',  minPrice: 2000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 43, keyword: 'ペプチア',                            itemCode: '2314-001829',  minPrice: 4000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 44, keyword: 'フラバン',                            itemCode: '2314-001852',  minPrice: 0,    maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 45, keyword: 'アンミ オイル',                       itemCode: '2314-001900',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  // #46: Win原データ 2314-0001163 は #10 と同じ桁数パターン疑い。crossmallItemCode=null で挿入
  { row: 46, keyword: 'エティアキシル',                      itemCode: null,           minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true, note: 'Win原データitemCode=2314-0001163(5桁疑い)。crossmallItemCode=null で挿入、要CROSSMALL確認' },
  { row: 47, keyword: 'ユリイロ チェリー',                   itemCode: '2314-001912',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: 'ウォッシュ', isActive: true },
  { row: 48, keyword: 'ナイスリムサポート エラグ酸のチカラ', itemCode: '2314-001914',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 49, keyword: 'プラチナアイ アサイ',                 itemCode: '2314-000698',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 50, keyword: 'ユリイロ ホワイトリリー',             itemCode: '2314-001842',  minPrice: 3000, maxPrice: 999999, excludeKeywords: 'ウォッシュ', isActive: true },
  { row: 51, keyword: 'プロキオン 60',                       itemCode: '2314-000533',  minPrice: 5000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 52, keyword: 'キラーバーナー 90',                   itemCode: '2314-001831',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 53, keyword: 'キラーバーナー 45',                   itemCode: '2314-001822',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 54, keyword: 'アカウス',                            itemCode: '2314-001358',  minPrice: 0,    maxPrice: 999999, excludeKeywords: 'ヘアゴム',   isActive: true },
  { row: 55, keyword: 'risou no cofffee',                    itemCode: '2314-001811',  minPrice: 3000, maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 56, keyword: 'シボローカ',                          itemCode: '2314-001300',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 57, keyword: 'シルクリスタ',                        itemCode: '2314-000559',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 58, keyword: 'ナイスリム',                          itemCode: '2314-001914',  minPrice: 1800, maxPrice: 999999, excludeKeywords: 'ラクトフェリン', isActive: true },
  { row: 59, keyword: 'nico 石鹸',                           itemCode: '2314-000546',  minPrice: 700,  maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 60, keyword: 'ニコ せっけん',                       itemCode: '2314-000546',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 61, keyword: 'クレ ブラック リムーバー',            itemCode: '2314-001296',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 62, keyword: 'WrinkFade ハイカバー',                itemCode: '2314-001890',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 63, keyword: 'シルキー バスト',                     itemCode: '2314-001930',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 64, keyword: 'デイリーワン マウス',                 itemCode: '2314-000889',  minPrice: 2800, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 65, keyword: 'バルクス レッドギア',                 itemCode: '2314-001373',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 66, keyword: 'ラクトフェリン 93',                   itemCode: '2314-000710',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 67, keyword: 'コンドロメート',                      itemCode: '2314-000939',  minPrice: 4000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 68, keyword: 'VALX RED GEAR',                       itemCode: '2314-001373',  minPrice: 3500, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 69, keyword: 'サラフェプラス 30g',                  itemCode: '2314-000188',  minPrice: 0,    maxPrice: 999999, excludeKeywords: '',           isActive: true },
  { row: 70, keyword: 'あもう酵素',                          itemCode: '2314-001541',  minPrice: 2000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
  { row: 71, keyword: '脳内核酸',                            itemCode: '2314-001159',  minPrice: 3000, maxPrice: 99999,  excludeKeywords: '',           isActive: true },
];

function fieldDiff(existing, incoming) {
  const diffs = [];
  const cmp = (label, oldVal, newVal) => {
    if (String(oldVal ?? '') !== String(newVal ?? '')) {
      diffs.push(`${label}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
    }
  };
  cmp('crossmallItemCode', existing.crossmallItemCode, incoming.crossmallItemCode);
  cmp('minPrice',          existing.minPrice,          incoming.minPrice);
  cmp('maxPrice',          existing.maxPrice,          incoming.maxPrice);
  cmp('excludeKeywords',   existing.excludeKeywords,   incoming.excludeKeywords);
  return diffs;
}

(async () => {
  await sequelize.query('PRAGMA journal_mode = WAL');
  await sequelize.query('PRAGMA busy_timeout = 5000');

  const beforeCount = await Keyword.count();
  const existing = await Keyword.findAll({ raw: true });
  const byKeyword = new Map(existing.map(k => [k.keyword, k]));

  const stats = {
    inputTotal: WIN_KEYWORDS.length,
    skippedInactive: 0,
    upsertUpdate: 0,       // 既存に一致 → 差分あり → 更新予定
    upsertNoop: 0,         // 既存に一致 → 差分なし → 変更なし
    insertNew: 0,          // 新規挿入
  };

  const upserts = [];
  const inserts = [];
  const noops = [];
  const skips = [];

  for (const w of WIN_KEYWORDS) {
    if (!w.isActive) {
      stats.skippedInactive++;
      skips.push({ row: w.row, keyword: w.keyword, reason: '無効（isActive=false）' });
      continue;
    }

    // Win#10 特別扱い: 既存itemCode維持のため crossmallItemCode 更新から除外
    const preserveItemCodeOnUpdate = w.row === 10;

    const existingRow = byKeyword.get(w.keyword);
    if (existingRow) {
      const incoming = {
        crossmallItemCode: preserveItemCodeOnUpdate ? existingRow.crossmallItemCode : w.itemCode,
        minPrice: w.minPrice,
        maxPrice: w.maxPrice,
        excludeKeywords: w.excludeKeywords,
      };
      const diffs = fieldDiff(existingRow, incoming);
      if (diffs.length === 0) {
        stats.upsertNoop++;
        noops.push({ row: w.row, keyword: w.keyword, existingId: existingRow.id });
      } else {
        stats.upsertUpdate++;
        upserts.push({ row: w.row, keyword: w.keyword, existingId: existingRow.id, diffs, note: w.note });
      }
    } else {
      stats.insertNew++;
      inserts.push({
        row: w.row,
        keyword: w.keyword,
        crossmallItemCode: w.itemCode,
        minPrice: w.minPrice,
        maxPrice: w.maxPrice,
        excludeKeywords: w.excludeKeywords,
        platforms: DEFAULT_PLATFORMS,
        note: w.note,
      });
    }
  }

  const afterCount = beforeCount + stats.insertNew;

  console.log('=== Win版キーワード移行 Dry-Run レポート ===');
  console.log(`モード: ${DRY_RUN ? 'DRY-RUN（DB書き込みなし）' : 'WRITE（実書き込み）'}`);
  console.log('');
  console.log('--- 集計 ---');
  console.log(`  Win入力件数           : ${stats.inputTotal}`);
  console.log(`  スキップ（無効）      : ${stats.skippedInactive}`);
  console.log(`  Upsert=更新           : ${stats.upsertUpdate}`);
  console.log(`  Upsert=変更なし       : ${stats.upsertNoop}`);
  console.log(`  新規挿入              : ${stats.insertNew}`);
  console.log(`  移行前Keyword件数     : ${beforeCount}`);
  console.log(`  移行後Keyword件数(予想): ${afterCount}`);
  console.log('');

  console.log('--- 更新される既存レコード ---');
  if (upserts.length === 0) {
    console.log('  （なし）');
  } else {
    for (const u of upserts) {
      console.log(`  [Win #${u.row}] "${u.keyword}" (id=${u.existingId})`);
      u.diffs.forEach(d => console.log(`      ${d}`));
      if (u.note) console.log(`      NOTE: ${u.note}`);
    }
  }
  console.log('');

  console.log('--- 変更なし（既存と一致） ---');
  if (noops.length === 0) {
    console.log('  （なし）');
  } else {
    for (const n of noops) {
      console.log(`  [Win #${n.row}] "${n.keyword}" (id=${n.existingId})`);
    }
  }
  console.log('');

  console.log('--- 新規挿入 ---');
  if (inserts.length === 0) {
    console.log('  （なし）');
  } else {
    for (const i of inserts) {
      console.log(`  [Win #${i.row}] "${i.keyword}"  itemCode=${i.crossmallItemCode ?? 'null'}  min=${i.minPrice} max=${i.maxPrice}  除外="${i.excludeKeywords}"`);
      if (i.note) console.log(`      NOTE: ${i.note}`);
    }
  }
  console.log('');

  console.log('--- スキップ（無効） ---');
  for (const s of skips) {
    console.log(`  [Win #${s.row}] "${s.keyword}" — ${s.reason}`);
  }
  console.log('');

  // 実書き込み
  if (!DRY_RUN) {
    console.log('=== 実書き込みモード：DBに反映します ===');
    const t = await sequelize.transaction();
    try {
      for (const u of upserts) {
        const winRow = WIN_KEYWORDS.find(w => w.row === u.row);
        const preserveItemCodeOnUpdate = winRow.row === 10;
        const updateFields = {
          minPrice: winRow.minPrice,
          maxPrice: winRow.maxPrice,
          excludeKeywords: winRow.excludeKeywords,
        };
        if (!preserveItemCodeOnUpdate) {
          updateFields.crossmallItemCode = winRow.itemCode;
        }
        await Keyword.update(updateFields, { where: { id: u.existingId }, transaction: t });
      }
      for (const i of inserts) {
        await Keyword.create({
          keyword: i.keyword,
          platforms: i.platforms,
          crossmallItemCode: i.crossmallItemCode,
          minPrice: i.minPrice,
          maxPrice: i.maxPrice,
          excludeKeywords: i.excludeKeywords,
          isActive: true,
          globalExcludeEnabled: true,
        }, { transaction: t });
      }
      await t.commit();
      console.log(`  更新: ${upserts.length}件、挿入: ${inserts.length}件 → コミット完了`);
      const finalCount = await Keyword.count();
      console.log(`  最終Keyword件数: ${finalCount}`);
    } catch (e) {
      await t.rollback();
      console.error('  エラー発生。ロールバック実施:', e.message);
      throw e;
    }
  } else {
    console.log('=== DRY-RUN終了: DBには一切書き込んでいません ===');
  }

  await sequelize.close();
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
