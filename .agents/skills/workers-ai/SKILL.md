---
name: workers-ai
description: Workers AI (env.AI) のモデル追加・切替・呼び出しコード変更時のチェックリスト。地域Q&A・エチケット解析などAI機能の変更、AIモデルのアップグレード検討時に使う。
---

# workers-ai: モデル追加・切替チェックリスト

過去のモデル切替(#100/#103/#106)とラベル解析導入(#108/#110)で繰り返し踏んだ穴のまとめ。

## モデル選定

- **wrangler が生成する `AiModels` 型に登録済みのモデルか確認する**。未登録モデル(例: GLM-5.2)は `env.AI.run` バインディングで `#options` エラーになり呼べない。`compatibility_date` を上げても解決しない(Workerの互換フラグではなくCloudflare側サービスの問題)。wrangler + `@cloudflare/vite-plugin` を新しい世代へペア更新すると型登録されて解消することがある(Gemma 4 は #103 で解消)。バインディングで呼べないモデルをどうしても使う場合は `/v1/chat/completions` 互換エンドポイント + APIトークンの別実装が必要。
- **能力差を先に確認**: 画像入力の可否(Gemma 4 は不可 → ラベル解析は Llama 4 Scout を採用 #108)。用途ごとにモデルが分かれるのは正常。

## 呼び出し実装

- **reasoning系モデルは thinking が出力トークン枠を食い、本文が途中切れ・空になる** → `chat_template_kwargs: { enable_thinking: false }` を指定する(#103 で completion 512→65 に改善)。`stripReasoning`(`<think>`除去)は現行モデルでは no-op だが将来用に温存されている(#100)。
- **`guided_json` を信用しない**。Llama 4 Scout はスキーマ指定しても型揺れJSON(数値が文字列、配列が単一値)を間欠的に返す(#110)。zodパースは寛容に書く(coerce・単一値→配列正規化)。厳格パースだと間欠500になる。
- **複数画像は1枚ずつ解析して結果をマージする**(1枚の失敗が全体を巻き込まないように。#110 の `mergeExtractions`)。
- **レスポンス形式はモデルで異なる**: `choices[0].message.content` と `response` の両形式を吸収する(#103/#106)。
- **クレジット消費を伴う呼び出しは reserve → `env.AI.run` → settle / 失敗時 refund の骨格必須**(docs/architecture.md)。`requestId` は用途プレフィックス付き一意キー、見積は入力量(画像枚数等)に比例させる(#110)。

## 検証

- **Workers AI にローカルシミュレータはない**(実推論=課金)。実機検証はプレビュー環境で行う。旧wranglerではローカルdevから呼べないモデルもある(#100)。
- MCPツール(`ask_region` 等)に関わる変更は `mcp-inspector-verify` で `Ask region` の実行(回答テキスト + `balance` 返却、残高不足時は `isError`)まで確認する。
- モデル切替時は同一プロンプトでの出力品質・所要トークンを新旧で比較し、PR本文に記録する。
