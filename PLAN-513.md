# Phase 1 (#513): Langfuse 送信の土台 + 地域Q&A

親Issue: #512（設計判断・PII方針はそちらを参照）

## やること

1. **依存追加**: `@langfuse/otel` / `@langfuse/tracing`（+ peer の `@opentelemetry/{api,core,sdk-trace-base,exporter-trace-otlp-http}`）
2. **`src/lib/observability/langfuse-mask.ts`**（+ unit テスト）: data URI / base64 らしき長大文字列 / 認証情報を落とす純関数。`mask` フックの唯一の関門
3. **`src/lib/observability/langfuse.ts`**: Langfuse へ出す唯一の入口
   - `BasicTracerProvider` + `LangfuseSpanProcessor`（`exportMode: "immediate"` / `mediaUploadEnabled: false` / `environment` / `mask`）
   - キー未設定なら no-op。flush は `waitUntil` に載せる
4. **`src/lib/services/metered-inference.ts`**: `finishMeteredInference` で trace 開始〜ok/failed 両方で結末を書いて閉じる。`MeteredInferenceContext` に `recordGeneration()` 追加。traceId は `createTraceId(requestId)` で決定的に導出
5. **`src/lib/services/ai-service.ts`**: `answerRegionQuestion` の `env.AI.run` が `ctx.recordGeneration()` で入力・出力・モデル・usage を報告
6. **`src/lib/observability/langfuse.workers.test.ts`**: workerd 上で OTLP ボディを検査
7. **docs**: `.dev.vars.example` / `docs/deployment.md` / `src/lib/observability/span.ts` 冒頭 / `docs/architecture.md` / `CLAUDE.md` / `renovate.json`

## 設計の要点

- trace id = `createTraceId(requestId)`（決定的）。root span には `parentSpanContext` にダミー親 span id を渡す
- AI SDK の telemetry は切ったまま。6箇所のモデル呼び出しは全て手動計装
- 送信の失敗でリクエストを壊さない（`waitUntil` + 例外は握る）
- PII: Langfuse にはテキスト入出力を載せる／写真は載せない（枚数・MIME・寸法・ハッシュのみ）。`mask` が関門

## 受け入れ条件（#513 より抜粋）

- [ ] typecheck / check / build / test / check:deploy / check:deploy:preview が緑
- [ ] workers テストが OTLP ボディを検査: 1推論=1trace+1generation / traceId 決定論的 / キー未設定なら fetch しない / 送信失敗で例外漏れしない / mask が data URI を落とす
- [ ] プレビュー実機で地域Q&A → Langfuse JP に trace が出る
- [ ] PR プレビューURL からも trace が届く
- [ ] 応答時間が体感で悪化しない（waitUntil）

## Claim

- branch: claude/issue-513-langfuse-phase-1
- last-heartbeat: 2026-08-20T08:30:40Z
- status: implementing
