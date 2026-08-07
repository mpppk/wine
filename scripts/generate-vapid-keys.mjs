#!/usr/bin/env node
import { ApplicationServerKeys, setWebCrypto } from "webpush-webcrypto";

// ライブラリは `self.crypto` を探すが、Node の ESM に `self` は無い。明示的に渡す。
setWebCrypto(globalThis.crypto);

// Web Push の VAPID 鍵ペアを作る(Issue #466)。
//
// 出力の使い分け:
//  - publicKey  … 公開情報。`wrangler.jsonc` の `vars.VAPID_PUBLIC_KEY` に置く
//                  (クライアントが購読を作るのに要るので、そもそもブラウザまで届く)
//  - privateKey … シークレット。`wrangler secret put VAPID_PRIVATE_KEY`
//                 (プレビューは `--env preview`)。**リポジトリに置かない**
//
// **鍵を入れ替えると既存の購読は全て無効になる**(購読はサーバの公開鍵に紐づく)。
// 入れ替えたら push_subscription を空にして、利用者に購読し直してもらう必要がある。
//
// 使い方: node scripts/generate-vapid-keys.mjs

const keys = await ApplicationServerKeys.generate();
const { publicKey, privateKey } = await keys.toJSON();

console.log("VAPID_PUBLIC_KEY (wrangler.jsonc の vars へ):");
console.log(publicKey);
console.log();
console.log("VAPID_PRIVATE_KEY (wrangler secret put VAPID_PRIVATE_KEY):");
console.log(privateKey);
