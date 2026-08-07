#!/usr/bin/env node

// Web Push の VAPID 鍵ペアを作る(Issue #466)。**WebCrypto だけで完結する**ので依存は無い。
//
// 出力の使い分け:
//  - publicKey  … 公開情報。`wrangler.jsonc` の `vars.VAPID_PUBLIC_KEY` に置く
//                  (クライアントが購読を作るのに要るので、そもそもブラウザまで届く)
//  - privateKey … シークレット。`wrangler secret put VAPID_PRIVATE_KEY`
//                 (プレビューは `--env preview`)。**リポジトリに置かない**
//
// 形式は src/lib/push/vapid.ts の import と一対:
//  - 公開鍵は raw(65バイト・0x04 始まり)の base64url。`k=` と `applicationServerKey` が
//    要求するのがこの形
//  - 秘密鍵は pkcs8 の base64url。`crypto.subtle.importKey("pkcs8", …)` で読める
//
// **鍵を入れ替えると既存の購読は全て無効になる**(購読はサーバの公開鍵に紐づく)。
// 入れ替えたら push_subscription を空にして、利用者に購読し直してもらう必要がある。
//
// 使い方: node scripts/generate-vapid-keys.mjs

const base64url = (buffer) =>
	Buffer.from(buffer)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

// 署名用途(ECDSA)で作る。VAPID の JWT は ES256。
const keyPair = await crypto.subtle.generateKey(
	{ name: "ECDSA", namedCurve: "P-256" },
	true,
	["sign", "verify"],
);

const publicKey = base64url(
	await crypto.subtle.exportKey("raw", keyPair.publicKey),
);
const privateKey = base64url(
	await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
);

console.log("VAPID_PUBLIC_KEY (wrangler.jsonc の vars へ):");
console.log(publicKey);
console.log();
console.log("VAPID_PRIVATE_KEY (wrangler secret put VAPID_PRIVATE_KEY):");
console.log(privateKey);
