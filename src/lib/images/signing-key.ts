import { env } from "cloudflare:workers";
import { importImageSigningKey } from "#/lib/images/signed-url";

// 署名URL(signed-url.ts)の鍵の入手経路。
//
// 鍵は環境ごとに独立していればよく、値そのものを人が知る必要はない。そこで
// 新しいシークレットを増やして「本番だけ設定済み・プレビューは未設定」という
// 環境差(BETTER_AUTH_SECRET が実際にそうなっている)を作らず、既にすべての環境に
// 存在する R2 バケットへ初回アクセス時に乱数を書き込んで使い回す。
//
// このオブジェクトキーは avatars/ でも wines/ でもないため、/api/images/$ の
// isAllowedImageKey が弾き、配信経路からは絶対に読み出せない。
const SIGNING_KEY_OBJECT = "_internal/image-url-signing-key";

/** HMAC-SHA256 の鍵長。 */
const KEY_BYTES = 32;

// isolate 内で使い回す。失敗した Promise を掴んだままにしないよう、
// reject 時はキャッシュを捨てて次のリクエストで作り直す。
let cachedKey: Promise<CryptoKey> | null = null;

export function getImageSigningKey(): Promise<CryptoKey> {
	if (!cachedKey) {
		const pending = loadOrCreateSigningKey();
		cachedKey = pending;
		pending.catch(() => {
			if (cachedKey === pending) cachedKey = null;
		});
	}
	return cachedKey;
}

async function loadOrCreateSigningKey(): Promise<CryptoKey> {
	const existing = await env.AVATARS.get(SIGNING_KEY_OBJECT);
	if (existing) return importImageSigningKey(await existing.arrayBuffer());

	const material = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
	await env.AVATARS.put(SIGNING_KEY_OBJECT, material);
	// 複数 isolate が同時に初期化しても1つの鍵に収束させるため、
	// 自分が書いた値ではなく書き込み後に読める値を採用する。
	const stored = await env.AVATARS.get(SIGNING_KEY_OBJECT);
	return importImageSigningKey(
		stored ? await stored.arrayBuffer() : material.buffer,
	);
}

/** テスト用: isolate 内キャッシュを捨てる。 */
export function resetImageSigningKeyCache(): void {
	cachedKey = null;
}
