---
name: mcp-inspector-verify
description: wineのMCPサーバー（src/lib/mcp/ や src/routes/api/mcp.ts）変更時に、MCP InspectorでOAuth接続〜tools/list〜list_aops/show_aop_map実行〜（UI変更なら）AppsタブでのApp描画までを実機確認する手順。MCP関連のTest Plan実施時に使う。
---

# mcp-inspector-verify

MCP サーバーの変更を、実際の MCP クライアント（MCP Inspector）から OAuth 接続して確認する。ブラウザ操作は Playwright で行う（都度その場で操作すればよく、専用の検証スクリプトを作る必要はない）。

**対象は MCP Inspector v2.0.0**（npm の `latest`）。v0.22.0 系とは起動方法・UI・実体パスが別物なので、古い手順のまま進めない（#361）。

## 前提・起動

- `.dev.vars` に `BETTER_AUTH_URL=http://localhost:3000` と `BETTER_AUTH_SECRET`（任意のランダム文字列）。初回・スキーマ変更後は `bun install && bun run db:migrate:local`。
- **サーバー類は run_in_background で起動する**（`( … & )` サブシェル起動はこの環境で SIGKILL される）。
- dev サーバー: `bun run dev`（:3000）。`POST /api/mcp` が 401 を返すまで待つ（`/` は SSR で 500 になることがあるが MCP には無関係）。

### Inspector v2 の起動（プロキシ変数を必ず落とす）

```bash
npm i @modelcontextprotocol/inspector@2 --prefix <scratchpad>/insp
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy NO_PROXY=localhost,127.0.0.1 \
  node <scratchpad>/insp/node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js --web
```

- **プロキシ変数を落とすのが必須**。Claude Code on the web はエージェントプロキシを環境変数で設定しており、Inspector v2 はそれを検出すると `HTTPS_PROXY / HTTP_PROXY is set but the `undici` package is not available` を返して**リクエストを一切発行しない**。サーバ行が 0ms で `Failed` になり、認証の問題に見えるが wine サーバには到達すらしていない（#361 の誤診の原因）。
- 実体は `clients/launcher/build/index.js`（v0.22 系の `client/bin/start.js` ではない）。`--web` が必要（他に `--cli` / `--tui`）。
- **v2 に `DANGEROUSLY_OMIT_AUTH` は無い**。起動ログが出す `http://localhost:6274?MCP_INSPECTOR_API_TOKEN=<64hex>` をそのまま開く。トークンは起動ごとに変わるのでログから拾う。
- proxy ポート 6277 は廃止。UI は :6274、MCP Apps 用サンドボックスは毎回ランダムポート。
- Playwright / Chromium は web 実行環境のグローバルを使う。project の node_modules を汚さないよう `playwright-core` はスクラッチパッド側に `npm i` し、Chromium は `/opt/pw-browsers/chromium-*/chrome-linux/chrome` を `executablePath` に渡す（`playwright install` は不要）。ブラウザ起動時は `args: ["--no-sandbox", "--no-proxy-server"]`。

### Apps タブを使うなら sandbox_proxy.html を配置する（上流バグの回避）

v2.0.0 の npm パッケージは `clients/web/static/sandbox_proxy.html` を**同梱し忘れている**（`package.json` の `files` に `clients/web/static` が無い）。未配置だと App 枠に `Sandbox not loaded: ENOENT: …/sandbox_proxy.html` と出て何も描画されない。**Inspector 起動前**に配置する（起動時に一度だけ読むため、後から置いても再起動が要る）:

```bash
D=<scratchpad>/insp/node_modules/@modelcontextprotocol/inspector/clients/web/static
mkdir -p "$D" && curl -sS -o "$D/sandbox_proxy.html" \
  https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/clients/web/static/sandbox_proxy.html
```

## 接続（対話的 OAuth。トークンの手動取得は不要）

v2 は 401 の `WWW-Authenticate` からディスカバリ〜DCR〜認可リダイレクトまで自動で行う。**事前にトークンを取る必要はない**。

1. **同じブラウザコンテキストで wine にサインアップしておく**（consent 画面がログイン済み前提のため）。`http://localhost:3000/signup` を開き、ページ内から `POST /api/auth/sign-up/email` を叩くのが速い（same-origin fetch なので `Origin` ヘッダは自動で付く）。
2. Inspector UI（`http://localhost:6274?MCP_INSPECTOR_API_TOKEN=…`）を開く。
3. **`Add Servers` → `+ Add manually`** → モーダルで Server ID=`wine`、**Transport=`streamable-http`**、URL=`http://localhost:3000/api/mcp` → `Add`。
   - Transport の選択肢は `stdio (local process)` / `sse (Server-Sent Events)` / `streamable-http`。stdio が既定で、切り替えるとフォームが Command/Args から URL に入れ替わる。
4. サーバ行の**トグルスイッチ**（`Connect or disconnect "wine"`）を ON にする。Connect ボタンは無い。
5. ブラウザが `/oauth/consent?consent_code=…` へ遷移するので **`Allow`** を押す。`http://localhost:6274/oauth/callback?code=…` に戻り、行が緑の **`Connected`** ＋ `MCP 2025-11-25` になる。
6. **2回目以降はトークンが永続化されているので同意画面は出ない**。トグル ON だけで接続する。作り直したいときは Server Settings の `Clear stored OAuth state`。

期待されるフロー（Network ログで確認できる）:

```
initialize → 401 (WWW-Authenticate: Bearer resource_metadata="…")
→ /.well-known/oauth-protected-resource/api/mcp (404) → /.well-known/oauth-protected-resource (200)
→ /.well-known/oauth-authorization-server (200)
→ POST /api/auth/mcp/register (redirect_uris: http://localhost:6274/oauth/callback) → 201
→ /oauth/consent → Allow → /oauth/callback?code=… → Connected
```

### Bearer を手で渡したい場合（切り分け用）

認証欄は追加フォームではなく**サーバ行の `Settings`（Server Settings ペイン）**にある。下部のアコーディオンを開く:

- **Custom Headers** → `+ Add Header` で `Authorization: Bearer <token>`。ただし**OAuth が設定済みだと `Authorization` は OAuth フローが所有し、ここの値は無視される**（ペイン内の説明文どおり）。
- **OAuth Settings** → Client ID / Client Secret / Scopes / Insufficient-scope response / `Clear stored OAuth state`。

カタログ直書きでも渡せる。`~/.mcp-inspector/mcp.json` はフラット形状で、**エントリ直下に `headers: Record<string,string>`** を書ける（UI 操作を丸ごと省ける）:

```json
{ "mcpServers": { "wine": {
  "type": "streamable-http", "url": "http://localhost:3000/api/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } }
```

トークンを自前で取るなら同一 Cookie セッションで: サインアップ `POST /api/auth/sign-up/email`（`Origin: http://localhost:3000` 必須、無いと 403 `MISSING_OR_NULL_ORIGIN`）→ DCR `POST /api/auth/mcp/register`（`token_endpoint_auth_method: "none"`）→ authorize `GET /api/auth/mcp/authorize`（PKCE `S256`）→ token `POST /api/auth/mcp/token`（form, `grant_type=authorization_code` ＋ `code_verifier`）。

## Tools タブ

上部ナビの **`Tools`**。11 ツール（get_current_user / ask_region / list_wine_regions / list_grape_varieties / list_aops / get_aop / show_aop_map / register_drunk_wine / update_drunk_wine / list_drunk_wines / add_wine_tasting）が並ぶこと。

- `list_aops` を選び `region_id` に `bourgogne` を入れて **`Execute Tool`** → 結果に `"count": 117` と AOP 配列が返る。
- AI 変更時は `ask_region`（`region_id: "bourgogne"`, `question` に「主なブドウ品種は?」等）を実行し、回答テキストと `balance`（消費後のクレジット残高）が返ることを確認（残高不足時は `isError` でクレジット不足メッセージ）。
- UI 検証なら `show_aop_map`（`region_id: "bourgogne"`）を実行し、結果に `ui://wine-aop/map` リソースが同梱されることを確認。

右ペインの `Protocol` / `Network` に `TOOLS/CALL` 等が `OK` で並ぶ。失敗の切り分けはここを見る。

## Apps タブ（UI 変更時）

上部ナビの **`Apps`**。`_meta.ui.resourceUri` を持つツールが `MCP Apps (2)`（`Show AOP map` / `Register Drunk Wine`）として並ぶ。選んで引数（`region_id: bourgogne` 等）を入れ **`Open App`**。

**v2.0.0 では App の中身がライブ描画されない既知の上流バグがある**（skill 手順の不備ではない）:

- `sandbox_proxy.html` 欠落 → 上の「前提・起動」で配置すれば App シェルは出る。
- **v2 はアプリHTMLに焼き込む CSP を `contents[]._meta.csp` からしか読まない**。wine は `@modelcontextprotocol/ext-apps` のサーバ側ドキュメントどおり `_meta.ui.csp` に置いている（`src/lib/mcp/server.ts`）ので丸ごと無視され、`default-src 'none'; … frame-src 'none'` が焼き込まれて `Refused to frame 'http://localhost:3000/'` になる。**wine 側が正しく、Inspector 側のバグ**なので `_meta` の形を Inspector に合わせて変えない。

このため、**Apps の描画確認は `/embed/map?region=bourgogne` を直接開いたスクリーンショットで代替する**（light / dark / モバイル幅）。Apps タブで確認できるのは「App として並ぶこと」「`RESOURCES/READ ui://…` と `TOOLS/CALL show_aop_map` が `OK` を返すこと」までで、そこまでは確認する。代替した旨は PR の動作確認結果に明記する。

## Playwright での自動操作

- **`waitUntil: "networkidle"` は使えない**。`/api/servers/events` の SSE が張りっぱなしで永久にタイムアウトする。`domcontentloaded` ＋ 明示的な `waitForTimeout` にする。
- **Mantine の要素 ID はレンダリングごとに再生成される**（`#mantine-wbdq2om7e` 等）ので固定セレクタは使えない。role / label ベースなら安定する:
  - `getByRole("button", { name: "Add Servers", exact: true })`
  - `getByText("+ Add manually")` → `getByRole("option", { name: "streamable-http" })`
  - `getByLabel('Connect or disconnect "wine"').click({ force: true })`（トグルは覆い被さる要素があるので `force`）
  - `getByLabel("region_id *")` / `getByRole("button", { name: "Execute Tool" })` / `getByRole("button", { name: "Open App" })`
- モーダル内の操作は **`.mantine-Modal-content` にスコープする**。`Add` は背後の `Add Servers` と前方一致するため、スコープしないとオーバーレイにクリックを弾かれる。
- Server Settings の `Custom Headers` / `OAuth Settings` / `Advertised Extensions` は**折りたたまれたアコーディオン**。開かずに「欄が無い」と判断しない（#361 の誤診の原因）。
- Server Settings の `Protocol Era` は既定 `Legacy`（2025-11-25 の initialize ハンドシェイク）で wine とは正常にネゴシエートする。`Modern` は 2026-07-28 のセッションレス版を pin する（#353 と関係する）。

## バージョンを固定したい場合

固定するなら **`1.0.1`（dist-tag `v1-latest`）**。`client/bin/start.js` レイアウトが v0.22 系と同じで旧手順がほぼそのまま通り、かつ `sandbox_proxy.html` を同梱している。`0.22.x` を選ぶ理由は無い。

## 実装時の定番の落とし穴（#55 / #185 のセルフレビューで検出された反復パターン）

- **サンドボックスiframeからのクロスオリジンfetchはCORSで不可** → App が必要とするマスタデータはブリッジHTML生成時に埋め込む。
- **オリジン検証は前方一致にしない**。`...workers.dev.evil.example` でバイパスされる → `new URL(u).origin` の厳密比較で行う。
- **`/api/images` は immutable 長期キャッシュ** → 画像更新の反映には `?v=updatedAt` のキャッシュバスタが必須。
- **保存系はホストの承認待ちで時間がかかる** → タイムアウトは長め(60秒級)にし、遅延応答も画面へ反映する。保存失敗時にIDを返さないとリトライで重複エントリが生まれる(Web/MCP両方で同型バグが出た)。
- **フォーム仕様(フィールド一覧・差分パッチ規約)をテンプレHTML内に手書きしない**。`fields.ts` 等のSSOTから生成し、テンプレ文字列内のJSロジックは純関数ミラー + テストで固定する(#185: 5重実装のドリフトで photo_urls 対応漏れが実害化)。
- **MCPツールを追加・削除したら本skillの期待ツール数(現在11)も更新する**(#100)。
- **マイセラーのツールは後方互換の確認を含める**: `register_drunk_wine` を新引数(status)を使わず `{name, drank_on, rating, memo}` だけで呼び、結果の `entry.drank_on` / `rating` / `memo` が従来どおり返ること。編集フォームAppで保存しても `tasting_count` が増えないこと(飲用記録は最新1件の in-place 更新。追加は `add_wine_tasting`)。

## ハマりどころ

- **App がライブ描画されるには、ツール宣言に `_meta.ui.resourceUri` が必要**（`server.ts` の `registerApps` で静的リソース `ui://wine-aop/map` を登録し、`show_aop_map` の `_meta.ui.resourceUri` で紐付ける）。tool 結果に mcp-ui リソースを同梱するだけでは Apps タブに出ない。
- `ui://` ブリッジ HTML（`apps.ts` の `buildAopMapAppHtml`）が host からデータを受け取るには、`ui/initialize` に **`protocolVersion` と `appInfo` が必須**。表示する region/grape/aop は host の `ui/notifications/tool-input`/`tool-result`（`arguments` や structuredContent の `region_id` 等）から取得する。データが届かないホストでは 1.5 秒後に既定地域（`bourgogne`）で描画される。
- **埋め込みビュー `/embed/map` は公開データのみを表示するため認証不要**（`src/routes/embed/map.tsx` のコメント参照）。ルート既定の `frame-ancestors 'none'` を空ポリシーで打ち消してあるのは、App の iframe が `allow-same-origin` 無しで不透明オリジンになり `frame-ancestors *` にマッチしないため（#189）。表示確認は `/embed/map?region=bourgogne` を直接開いたスクリーンショットで行う（light / dark / モバイル幅）。

## 証跡

スクショは **Gyazo に curl API でアップ**（CLI は proxy 経由で socket 失敗する。curl は CA バンドルで通る）:

```bash
curl -sS -X POST https://upload.gyazo.com/api/upload \
  -F "access_token=$GYAZO_ACCESS_TOKEN" -F "imagedata=@shot.png"
```

得た URL を PR description の「動作確認結果」に記載する（画像はリポジトリにコミットしない）。
