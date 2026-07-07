# Yahoo!フリマ 運用ガイド

## 1. IPレート制限の実態
- 429（Too Many Requests）が発生する負荷条件：
  - 20kw×並列2で約40秒後に発生（階層化スキャン導入前）
  - 8kw×並列1でも8分休止後の再試行で即発生した実績あり
  - 20kw×並列1（階層化スキャンあり）では62分間安定稼働後に発生
- ペナルティ解除の実測：約1時間で解除される事例あり（21:00 canary 429 → 22:00復旧）。
  ただし、プロセス側のin-memory breakerは自動では解除されない。PM2 restartが必要
- 短時間休止（4-8分）では復旧しないパターンが複数回確認されている
  （20:31発動→20:35restart→14秒で即再発）
- サンプル数は限定的で確定則ではなく、今後も観測を継続する

## 2. 正しいリカバリ手順
- 誤り: 「固定時間（6時間等）休止すれば必ず復旧する」という思い込み
- 誤り: 「PM2 restartでin-memory breakerをクリアすれば再開できる」という思い込み
  （Yahoo側のペナルティが継続中なら、restart直後でも即429が再発する）
- 正しい手順:
  1. logs/yahoo-ratelimit-watch.log のcanary監視（毎時0分、1req/hour）で
     200復帰を確認する
  2. canaryが複数回（最低2-3回）連続で200を返すことを確認してから再開する
  3. PM2 restartでin-memory breakerをクリアし、Stage 1（1kw）から再開する
- 429発生時はcascading circuit breaker（実装済み、直近30分で2回検出で
  自動停止+Telegram通知）が作動し、被害を自動的に最小化する

## 3. 安全な拡大手順（段階的アプローチ）
- 実績のある安定構成: 8kw allowlist + 並列度1(SCRAPING_CONCURRENCY_YAHOO=1)
  + リクエスト間sleep 1500ms(YAHOO_REQUEST_SLEEP_MS=1500)
  - 実測: 約94-103リクエスト/60分で429ゼロ、複数回再現性あり
- 拡大時は必ず前段階の構成で安定実績（最低60分429ゼロ）を確認してから
  次の段階に進む
- 20kw以上への拡大は、階層化スキャンのCold tier内で特定キーワードに
  アクセスが集中しないよう、分散対策とセットで設計すること
  - 20kw構成での429発生時、Hot 1kw(60req)+Warm 2kw(24req)+Cold 11kw(33req)、
    合計約120req/60分で発生。Stage 2(8kw,約103req)との差はわずか17reqのため、
    「総リクエスト数」より「Cold tier 11kwの同時集中処理」が真因の可能性が高い
- 検討候補（20kw再挑戦時）:
  - Cold tier スキャン内でのkw間sleep追加（現状Cold内は連続処理）
  - Cold tierの細分化（サブtier化）
  - Cold間隔延長（30→60分）は集中バースト自体は解消しないため効果限定的

## 4. 監視の仕組み
- logs/yahoo-ratelimit-watch.log: cronによる毎時canary監視
- cascading circuit breaker: src/services/ScrapingService.jsに実装済み、
  YAHOO_429_WINDOW_MS・YAHOO_429_THRESHOLDで閾値設定
- Telegram通知: aicham_dev_bot経由で自動停止時に通知
- 階層化スキャン（Hot/Warm/Cold）導入により、20kw構成でも429発生までの
  時間が大幅に延長された（即時→62分）。分散効果は確実にあるが、
  Cold tier集中の問題は別途対策が必要

## 5. 今後の課題
- 20kw以上への拡大設計（Cold tier分散対策）
- ペナルティ解除時間（1時間）の再現性検証（サンプルを増やす）
- 重複通知バグ（同一Mercari出品を複数overlappingキーワードが拾う問題）
- CROSSMALL get_stockタイムアウトのretryロジック
