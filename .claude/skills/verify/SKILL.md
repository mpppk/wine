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

## 主要フロー

- 地図: `/map/bourgogne?aop=gevrey-chambertin` (AOP選択状態へ直接deep link可)
- クイズ: `/quiz` → `/quiz/play?region=X`。地図内クイズは詳細パネル/ツールバーのボタンから
- 未ログインでもクイズ回答可(記録なし)。記録・進捗の確認はログインが必要
