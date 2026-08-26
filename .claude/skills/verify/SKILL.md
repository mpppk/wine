---
name: verify
description: このリポジトリの変更をローカルで実機確認する手順(ビルド・起動・ブラウザ駆動)。GUI変更のverify時に使う。
---

# wine ローカル実機確認

## 起動

```bash
bun install                 # 初回のみ
bun run db:migrate:local    # 初回・スキーマ変更後のみ
bun run dev                 # http://localhost:3000 (バックグラウンド起動推奨)
```

起動確認: `curl -s --noproxy localhost -o /dev/null -w "%{http_code}" http://localhost:3000/`

## ブラウザ駆動 (Playwright)

- スクラッチパッドで `bun add playwright-core`、`chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } })`
  - proxy設定が無いと外部タイル(openfreemap)がハングし `networkidle` が永遠に来ない。`waitUntil: "domcontentloaded"` を使う
- SSR後のハイドレーション完了前はクリックが効かない。目的の要素が現れるまでクリックをリトライするヘルパを使う
- ダイアログのセレクタは `[data-slot="dialog-content"]:visible` にする(CommandPalette の hidden dialog が常時DOMにあり衝突する)
- サーバ関数のレスポンスは `/_serverFn/<base64>` のURLで、bodyはTanStack独自シリアライズ(素のJSONではない)。中身の検証は生テキストへの正規表現が手軽

## プレビュー環境(Cloudflare Workers)の検証

- Chromiumにプロキシを直接設定すると外部HTTPSのCONNECTが切られる。代わりにプロキシなしで起動し、`context.route("**/*")` で全リクエストを `request.newContext({ proxy: { server: process.env.HTTPS_PROXY }, ignoreHTTPSErrors: true })` の `api.fetch(route.request())` → `route.fulfill({ response })` で代行する
- このときスクリプトは、**`bun --version` が 1.3.13 以下なら Bun ではなく Node で実行する**(1.3.13 以下の bun は `fetch` の ClientHello に ECH GREASE(`encrypted_client_hello` 拡張)を付け、agentプロキシのTLS終端がそのハンドシェイクを黙って捨てるため "The socket connection was closed unexpectedly"(ECONNRESET) になる)。gyazo CLI も `#!/usr/bin/env bun` で同じ理由で失敗するため、アップロードは `curl -X POST https://upload.gyazo.com/api/upload -H "Authorization: Bearer $GYAZO_ACCESS_TOKEN" -F "imagedata=@file.png"` を使う
  - **HTTPS_PROXY 非対応が原因ではない**。bun は HTTPS_PROXY を読んでおり `CONNECT <host>:443` → `200 Connection Established` までは正常に進む。落ちるのはその先のTLSハンドシェイクで、ECH拡張だけを取り除いた同一の ClientHello はそのトンネルで ServerHello が返る。bun でも `node:net`+`node:tls` を直接使う経路(ECHを付けない)なら通る
  - Bun 側は **v1.3.14 で修正済み**(fetch の ECH GREASE を無効化し curl / Node / `node:tls` と揃えた)。1.3.14 以上なら bun の `fetch` も playwright の `api.fetch` もそのまま通るので Node への切り替えは不要。リポジトリは `packageManager` で 1.4.0 を固定しているが、**実行コンテナに入っている bun はイメージ側の版で `packageManager` には追従しない**ので、毎回 `bun --version` を見て判断する(古ければ Node で代替するか、`curl -fsSL https://bun.com/install | BUN_INSTALL=<scratchpad>/bun bash -s bun-v1.4.0` で新しい bun をスクラッチパッドに入れて使う)
  - `api.github.com` は 1.3.13 以下の bun でも通る(トークン注入のためプロキシ側の別経路でTLS終端されており ECH を許容する)。「bun の fetch が全部落ちる」わけではないので切り分け時に注意
- MapLibreの地図をスクリーンショットに写すには `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` で起動し、描画を数秒待つ

## プレビューに到達できない場合の代替手順

実行環境によってはプレビューURLへのブラウザ到達が失敗する(agentプロキシがChromiumのCONNECTを `ERR_CONNECTION_RESET` にする / bot保護のError 1010がスクリプトHTTPを弾く)。過去のPRで十数回発生しており、その場合は以下で代替し、**PR本文の動作確認結果に「プレビュー到達不可のためローカルで代替した」旨と実施内容を明記する**:

1. ローカルで同一内容を検証: `bun run db:migrate:local`(PRのマイグレーション込み) → `bun run dev` + 上記Playwright手順でスクショ撮影(Gyazoアップは curl API)
2. プレビューには curl でSSRの実HTML/レスポンスヘッダを検証する(curlはプロキシを通ることが多い): `curl -sS https://<branch>-wine-preview.niboshi.workers.dev/... `
3. DBへの書き込み結果の裏取りは `npx wrangler d1 execute DB --remote --env preview --command "SELECT ..."`
4. MCP実機確認が同じ理由で不可の場合は、ローカル(:3000)に対して `mcp-inspector-verify` を実施し、その旨を記載する

## 共有プレビューDBのデータ規律

- 検証で作成したデータ(テストサブスクリプション・ダミーエントリ等)は全プレビュー環境から見える。確認が終わったら削除する(#59 でテスト用activeサブスクが残留し手動クリーンアップになった)
- テストアカウントは必ず `+claude-test` 付きメールで作る。本人メールのアカウントには触らない

## ログイン検証用アカウント

- `TEST_USER_PASSWORD` 環境変数がテスト用パスワード。`CLAUDE_CODE_USER_EMAIL` を `+claude-test` 付き(例: `user+claude-test@gmail.com`)にしたテストアカウントを `/signup` から作成して使う(プレーンの本人メールのアカウントには触らない)
- プレビューDB(`wine-preview-db`)は全プレビュー環境で共有なので、一度作ればPRをまたいで使い回せる

## 主要フロー

- 地図: `/map/bourgogne?aop=gevrey-chambertin` (AOP選択状態へ直接deep link可)
- クイズ: `/quiz` → `/quiz/play?region=X`。地図内クイズは詳細パネル/ツールバーのボタンから
- 未ログインでもクイズ回答可(記録なし)。記録・進捗の確認はログインが必要
