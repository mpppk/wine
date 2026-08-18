# #486 実装プラン: サーバ側の予期しない例外を Sentry で拾えるようにする

## 概要

`@sentry/cloudflare` の `withSentry` で `src/worker.ts` の export を包み、
予期しない例外(fetch/SSR、server function、キューコンシューマ)を Sentry に自動送信する。

## 変更内容

1. `@sentry/cloudflare` を dependencies に追加
2. `src/worker.ts` の `export default { fetch, queue }` を `withSentry` で包む
3. 設定:
   - `dsn`: `env.SENTRY_DSN`(#395 で投入済みのシークレット)
   - `tracesSampleRate`: 設定しない(トレースは入れない)
   - `enableLogs`: 設定しない
   - `dataCollection.userInfo: false`(クライアント側 `sendDefaultPii: false` と揃える)
4. `src/env-secrets.d.ts` の `SENTRY_DSN` は既に宣言済み(コメント更新)

## 確認事項

- `satisfies ExportedHandler<Env>` を付けない既存の判断と `withSentry` の型が噛み合うか
- `operator-alert`(#395)との重複送信がないか(同じ例外が両方から送られないか)
- `bun run typecheck` / `check` / `build` / `test` / `check:deploy` / `check:deploy:preview`
- プレビュー実機で目視確認(worker が壊れないこと)
- cold start への影響

## 検討

- Sentry プロジェクトを1つにまとめるか: クライアント(#381/#382)と同じプロジェクトに
  送る(environment で production / preview / local を区別する)。SENTRY_DSN は
  #395 で既に投入済み。