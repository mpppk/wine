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
export const SIGNING_KEY_OBJECT = "_internal/image-url-signing-key";

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
	// 「無ければ作る」を条件付き put で原子的に行う。複数 isolate が同時に
	// 初期化しても勝者は1つに決まり、負けた put は null を返して上書きしない。
	// 勝った後は誰も上書きできない(生成はこの条件付き put だけ)ので、
	// 勝者は自分が書いた値をそのまま使う。
	const created = await env.AVATARS.put(SIGNING_KEY_OBJECT, material, {
		onlyIf: { etagDoesNotMatch: "*" },
	});
	if (created) return importImageSigningKey(material);
	// 負けた側は必ず読み直し、勝者の鍵に収束させる。自分の乱数は捨てる。
	// R2 の書き込みは強整合なので、負けが確定した時点で勝者の値は読めるはず。
	// 万が一読めなければ例外にして fail-closed(呼び出し側が署名経路を諦める)に
	// 任せる。自分の乱数で署名し続けると isolate ごとに鍵が割れる(#642)ため、
	// フォールバックとして使わない。reject された Promise は getImageSigningKey
	// がキャッシュから捨てるので、次のリクエストで作り直す。
	const stored = await env.AVATARS.get(SIGNING_KEY_OBJECT);
	if (!stored) {
		throw new Error(
			"image signing key lost the creation race and is unreadable",
		);
	}
	return importImageSigningKey(await stored.arrayBuffer());
}

/** テスト用: isolate 内キャッシュを捨てる。 */
export function resetImageSigningKeyCache(): void {
	cachedKey = null;
}
