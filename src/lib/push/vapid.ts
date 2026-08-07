// VAPID(RFC 8292)の署名。**WebCrypto だけで完結する**ので依存を持たない(#466)。
//
// ここが自前で書ける理由と、本文の暗号化を自前で書かない理由は同じ土俵にある:
//
//  - VAPID は「標準的な ES256 の JWT」でしかない。しかも**自動テストで検証できる**——
//    署名した結果を `crypto.subtle.verify` で検証し、クレームを読み返せば正しさが閉じる
//  - 本文の暗号化(RFC 8291)は ECDH + HKDF + AES-GCM + フレーミングの組み合わせで、
//    正しさを閉じるには「実際に届いて復号できること」を見るしかない。この環境では
//    それができない(ヘッドレス Chromium がプッシュ購読を作れない)
//
// そこで**本文を送らない**設計にした。送るものが無ければ暗号化する対象も無くなり、
// 残るのはこの VAPID だけになる。通知の文言は Service Worker がアプリのAPIから取る。

/** JWT の有効期間。RFC 8292 は最大24時間を許すが、短いほど漏れたときの窓が狭い。 */
const JWT_TTL_SECONDS = 12 * 60 * 60;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of view) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64urlToBytes(value: string): Uint8Array {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const raw = atob(padded);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

function base64urlJson(value: unknown): string {
	return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * VAPID 秘密鍵(pkcs8 / base64url)を署名鍵として読み込む。
 *
 * 形式は `scripts/generate-vapid-keys.mjs` の出力と一対。壊れた鍵はここで throw する
 * (呼び出し側が「全ユーザに送れない」として記録する)。
 */
export async function importVapidPrivateKey(
	privateKeyBase64url: string,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"pkcs8",
		// BufferSource には ArrayBuffer を渡す(Uint8Array の buffer は ArrayBufferLike)。
		base64urlToBytes(privateKeyBase64url).buffer as ArrayBuffer,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
}

/**
 * 1つの endpoint 宛の VAPID 認可ヘッダを組む。
 *
 * `aud` は**エンドポイントのオリジン**でなければならない(パスまで入れると弾かれる)。
 * プッシュサービスは受け取った JWT の `aud` が自分自身かを確認する。
 *
 * @param endpoint 送信先の購読エンドポイント
 * @param privateKey `importVapidPrivateKey` で読み込んだ署名鍵
 * @param publicKeyBase64url 生形式(65バイト)の公開鍵。`k=` に載る
 * @param subject 送信元の連絡先(`mailto:` か `https:`)
 * @param nowMs 署名時刻。テストから固定するために受け取る
 */
export async function createVapidAuthorization(options: {
	endpoint: string;
	privateKey: CryptoKey;
	publicKeyBase64url: string;
	subject: string;
	nowMs?: number;
}): Promise<string> {
	const { endpoint, privateKey, publicKeyBase64url, subject } = options;
	const nowMs = options.nowMs ?? Date.now();
	const audience = new URL(endpoint).origin;

	const header = base64urlJson({ typ: "JWT", alg: "ES256" });
	const payload = base64urlJson({
		aud: audience,
		exp: Math.floor(nowMs / 1000) + JWT_TTL_SECONDS,
		sub: subject,
	});
	const signingInput = `${header}.${payload}`;

	// **WebCrypto の ECDSA 署名は既に JOSE 形式(生の r||s、64バイト)**。JWT が要求する
	// のもこれなので、DER からの変換は要らない(Node の crypto は DER を返すため、
	// そちらのコードを持ってくると二重変換になる)。
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		privateKey,
		new TextEncoder().encode(signingInput),
	);

	// RFC 8292 の形式。draft-04 の `WebPush <jwt>` + `Crypto-Key: p256ecdsa=` ではなく
	// **標準形**を使う(本文を送らないので、draft-04 に合わせる理由がもう無い)。
	return `vapid t=${signingInput}.${base64url(signature)}, k=${publicKeyBase64url}`;
}

/** テストが署名を検証するために、生形式の公開鍵を検証鍵として読み込む。 */
export async function importVapidPublicKey(
	publicKeyBase64url: string,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		base64urlToBytes(publicKeyBase64url).buffer as ArrayBuffer,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
}

/** `vapid t=…, k=…` を分解する(テストと、将来の検証用)。形が違えば null。 */
export function parseVapidAuthorization(
	header: string,
): { jwt: string; publicKey: string } | null {
	const match = /^vapid t=([^,\s]+),\s*k=(\S+)$/.exec(header);
	if (!match?.[1] || !match[2]) return null;
	return { jwt: match[1], publicKey: match[2] };
}

/** JWT のクレームを読む(署名の検証は別。テストと調査用)。 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
	const part = jwt.split(".")[1];
	if (!part) return null;
	try {
		return JSON.parse(new TextDecoder().decode(base64urlToBytes(part)));
	} catch {
		return null;
	}
}

/** JWT の署名を検証する(テスト用。送信側は署名するだけ)。 */
export async function verifyJwtSignature(
	jwt: string,
	publicKey: CryptoKey,
): Promise<boolean> {
	const [header, payload, signature] = jwt.split(".");
	if (!header || !payload || !signature) return false;
	return crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		publicKey,
		base64urlToBytes(signature).buffer as ArrayBuffer,
		new TextEncoder().encode(`${header}.${payload}`),
	);
}
