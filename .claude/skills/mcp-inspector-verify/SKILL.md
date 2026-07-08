---
name: mcp-inspector-verify
description: wineのMCPサーバー（src/lib/mcp/ や src/routes/api/mcp.ts）変更時に、MCP InspectorでOAuth接続〜tools/list〜list_aops/show_aop_map実行〜（UI変更なら）AppsタブでのApp描画までを実機確認する手順。MCP関連のTest Plan実施時に使う。
---

# mcp-inspector-verify

MCP サーバーの変更を、実際の MCP クライアント（MCP Inspector）から OAuth 接続して確認する。ブラウザ操作は Playwright で行う（都度その場で操作すればよく、専用の検証スクリプトを作る必要はない）。

## 前提・起動

- `.dev.vars` に `BETTER_AUTH_URL=http://localhost:3000`。初回・スキーマ変更後は `bun install && bun run db:migrate:local`。
- **サーバー類は run_in_background で起動する**（`( … & )` サブシェル起動はこの環境で SIGKILL される）。
  - dev サーバー: `bun run dev`（:3000）。`/api/mcp` が 401 を返すまで待つ（`/` は SSR で 500 になることがあるが MCP には無関係）。
  - MCP Inspector: `DANGEROUSLY_OMIT_AUTH=true MCP_AUTO_OPEN_ENABLED=false node <inspector>/client/bin/start.js`（UI :6274 / proxy :6277）。npx で入れた実体は `~/.npm/_npx/*/node_modules/@modelcontextprotocol/inspector/client/bin/start.js`。**`npx @modelcontextprotocol/inspector --version` はバージョン表示ではなくフルの Inspector を起動してしまう**ので、実体パスを直接 node で起動するのが安定。ポート 6277 が使用中なら残プロセスを kill してから起動。
- Playwright / Chromium は web 実行環境のグローバルを使う。project の node_modules を汚さないよう `playwright-core` はスクラッチパッド側に `bun add` し、Chromium は `/opt/pw-browsers/chromium-*/chrome-linux/chrome` を `executablePath` に渡す（`playwright install` は不要）。

## Bearer トークンの取得（OAuth 2.1 / PKCE）

同一 Cookie セッションで以下を実行（localhost なので `HTTPS_PROXY= NO_PROXY=localhost`）:

1. サインアップ: `POST /api/auth/sign-up/email`（`Origin: http://localhost:3000` ヘッダ必須、無いと 403 `MISSING_OR_NULL_ORIGIN`）。
2. DCR: `POST /api/auth/mcp/register`（`token_endpoint_auth_method: "none"`、`redirect_uris` 登録）→ `client_id`。
3. authorize: `GET /api/auth/mcp/authorize`（PKCE `S256`）。ログイン済みなので consent 承認 → `redirect_uri?code=...`。
4. token: `POST /api/auth/mcp/token`（form, `grant_type=authorization_code` ＋ `code_verifier`）→ `access_token`。
5. （任意・切り分け用）`POST /api/mcp` に `Authorization: Bearer <token>` ＋ `Accept: application/json, text/event-stream` で `initialize` → `tools/list` → `tools/call list_aops`（`region_id: "bourgogne"`）を叩き、AOP 一覧が返ることを確認。UI 検証なら `tools/call show_aop_map`（`region_id: "bourgogne"`）で `ui://wine-aop/map` リソース同梱を先に確認しておく。

## Inspector UI 操作（Playwright / v0.22.0 系）

ブラウザは **`http://localhost:6274`** で開く（`127.0.0.1:6274` だと proxy が "Invalid origin" 403）。

1. **Transport Type**（combobox）→ **Streamable HTTP** を選択。
2. **URL** に `http://localhost:3000/api/mcp`。
3. **Authentication** を開く → **Custom Headers** の行で Header Name=`Authorization`（既定）、値（`input[type=password]`）に `Bearer <token>` を入れ、**行の toggle を ON**（OFF のままだと送信されない）。
4. **Connect** → 左下が緑の **Connected** になる。
5. **Tools タブ**: `List Tools` で 6 ツール（get_current_user / list_wine_regions / list_grape_varieties / list_aops / get_aop / show_aop_map）が出ること。`List aops` を選び `region_id` に `bourgogne` を入れ **Run Tool** → **Tool Result: Success**、結果に AOP 配列が入ることを確認。UI 検証なら `Show aop map`（`region_id: "bourgogne"`）を実行し、結果に `ui://wine-aop/map` リソースが同梱され、右パネル Meta に `ui.resourceUri` があることを確認。
6. **Apps タブ**（UI 変更時）: `_meta.ui.resourceUri` を持つ `show_aop_map` が App として並ぶ。選択して Open すると App シェル（AOP 地図）が iframe に `/embed/map` を読み込み、地図が描画される。

## ハマりどころ

- **App がライブ描画されるには、ツール宣言に `_meta.ui.resourceUri` が必要**（`server.ts` の `registerApps` で静的リソース `ui://wine-aop/map` を登録し、`show_aop_map` の `_meta.ui.resourceUri` で紐付ける）。tool 結果に mcp-ui リソースを同梱するだけでは Apps タブに出ない。
- `ui://` ブリッジ HTML（`apps.ts` の `buildAopMapAppHtml`）が host からデータを受け取るには、`ui/initialize` に **`protocolVersion` と `appInfo` が必須**。表示する region/grape/aop は host の `ui/notifications/tool-input`/`tool-result`（`arguments` や structuredContent の `region_id` 等）から取得する。データが届かないホストでは 1.5 秒後に既定地域（`bourgogne`）で描画される。
- **埋め込みビュー `/embed/map` は公開データのみを表示するため認証不要**（`src/routes/embed/map.tsx` のコメント参照）。サードパーティ iframe ではセッション Cookie が送られないことを前提とした設計なので、Inspector の Apps サンドボックス（クロスオリジン :6277）からでも `/login` にリダイレクトされず、そのまま地図が描画される。表示確認は Apps タブの Open、または `/embed/map?region=bourgogne` を直接開いたスクリーンショットで行う（light / dark / モバイル幅）。

## 証跡

スクショは **Gyazo に curl API でアップ**（CLI は proxy 経由で socket 失敗する。curl は CA バンドルで通る）:

```bash
curl -sS -X POST https://upload.gyazo.com/api/upload \
  -F "access_token=$GYAZO_ACCESS_TOKEN" -F "imagedata=@shot.png"
```

得た URL を PR description の「動作確認結果」に記載する（画像はリポジトリにコミットしない）。
