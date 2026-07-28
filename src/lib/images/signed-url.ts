// 非公開画像(マイセラーのワイン写真)の認可と短命署名URL。
//
// /api/images/$ は R2 の avatars/ と wines/ を配信するが、この2つは機密性が違う。
// avatars/ は公開プロフィール画像で誰が見てもよい。wines/ はユーザ非公開の
// マイセラー写真で、これまで「URL(UUID)が推測できないこと」だけが機密性の
// 根拠になっていた(Issue #149)。URLが一度でも漏れれば無認証で恒久的に読めてしまう。
//
// そこで wines/ には2つの認可経路を用意する:
//   1. 本人セッション  — Webアプリ内の <img> は same-origin で Cookie が乗る
//   2. 短命の署名付きURL — MCP/埋め込みビュー(サンドボックス iframe)は Cookie が
//      乗らないため、有効期限とキーをHMACで束ねたURLで配信する
//
// このモジュールはランタイム非依存(cloudflare:workers を import しない)に保ち、
// 鍵の取得だけを signing-key.ts に分離する。jsdom 上のユニットテストから検証できる。

/**
 * 署名URLの有効期間。MCPホスト(Claude 等)の会話履歴やログにURLが残っても、
 * 露出が恒久化しない長さにする。切れた場合はツールを呼び直せば新しいURLが得られる。
 */
export const SIGNED_IMAGE_URL_TTL_MS = 60 * 60 * 1000;

/** 署名の対象文字列のバージョン。書式を変えるときは上げる(旧署名は一斉に無効になる)。 */
const SIGNATURE_VERSION = "v1";

/** 有効期限のクエリパラメータ名(UNIX秒)。 */
export const EXPIRES_PARAM = "exp";
/** 署名のクエリパラメータ名(base64url)。 */
export const SIGNATURE_PARAM = "sig";

/** 画像配信ルートのパス接頭辞。R2キーとURLの相互変換はこの2関数に集約する。 */
const IMAGE_PATH_PREFIX = "/api/images/";

/** R2キーから配信URLの相対パスを作る。 */
export function imagePathForKey(r2Key: string): string {
	return `${IMAGE_PATH_PREFIX}${r2Key}`;
}

/** 配信URL(相対パス)からR2キーを復元する。DTOのURLはクエリを持たない。 */
export function imageKeyFromPath(path: string): string {
	return path.startsWith(IMAGE_PATH_PREFIX)
		? path.slice(IMAGE_PATH_PREFIX.length)
		: path;
}

/**
 * 認可が必要なR2キーか。wines/ 配下=マイセラー写真のみが非公開で、
 * avatars/ は公開プロフィール画像なので対象外(従来どおり無認証で配信する)。
 */
export function isPrivateImageKey(key: string): boolean {
	return key.startsWith("wines/");
}

/**
 * wines/{userId}/{entryId}/{photoId}.{ext} から所有者のユーザIDを取り出す。
 * この形以外(将来の別レイアウトや壊れたキー)は null を返し、呼び出し側は
 * セッションによる認可を諦める(署名付きURLでのみ配信される)。
 */
export function ownerOfPrivateImageKey(key: string): string | null {
	const m = /^wines\/([^/]+)\/[^/]+\/[^/]+$/.exec(key);
	return m?.[1] ?? null;
}

/**
 * そのユーザの非公開画像(マイセラー写真)を全て含むR2キーの接頭辞。
 * 退会・ユーザ削除時の一括削除で列挙の起点に使う(#252)。
 *
 * キーのレイアウトは ownerOfPrivateImageKey が解釈する形と一対でなければ
 * ならない。片方だけ変えると「所有者は判定できるが削除で拾えない」ズレが
 * 生まれ、削除したはずの個人データが R2 に残る。同じモジュールに置いて
 * テストで往復させるのはそのため。
 */
export function privateImagePrefixForUser(userId: string): string {
	return `wines/${userId}/`;
}

/** HMAC-SHA256 の署名鍵として鍵素材をインポートする。 */
export function importImageSigningKey(
	material: ArrayBuffer | Uint8Array,
): Promise<CryptoKey> {
	// BufferSource として渡すため、Uint8Array はそのまま使える。
	return crypto.subtle.importKey(
		"raw",
		material as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/**
 * 署名対象。R2キーと有効期限を束ねることで、URLを持っていても
 * 「別のキーへの付け替え」「期限の書き換え」ができないようにする。
 */
function signedPayload(r2Key: string, expiresAtSec: number): Uint8Array {
	return new TextEncoder().encode(
		`${SIGNATURE_VERSION}:${r2Key}:${expiresAtSec}`,
	);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** R2キーと有効期限(UNIX秒)に対する署名を作る。 */
export async function signImageKey(
	key: CryptoKey,
	r2Key: string,
	expiresAtSec: number,
): Promise<string> {
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		signedPayload(r2Key, expiresAtSec) as BufferSource,
	);
	return toBase64Url(new Uint8Array(sig));
}

/**
 * クエリの exp / sig を検証する。期限切れ・書式不正・署名不一致はすべて false。
 * 比較は crypto.subtle.verify に任せる(自前のバイト比較でタイミング差を作らない)。
 */
export async function verifyImageSignature(
	key: CryptoKey,
	r2Key: string,
	expParam: string | null,
	sigParam: string | null,
	nowMs: number,
): Promise<boolean> {
	if (!expParam || !sigParam) return false;
	if (!/^\d{1,15}$/.test(expParam)) return false;
	const expiresAtSec = Number(expParam);
	if (expiresAtSec * 1000 <= nowMs) return false;
	const sig = fromBase64Url(sigParam);
	if (!sig) return false;
	return crypto.subtle.verify(
		"HMAC",
		key,
		sig as BufferSource,
		signedPayload(r2Key, expiresAtSec) as BufferSource,
	);
}

/** 現在時刻から TTL 後の有効期限(UNIX秒)。 */
export function expiresAtFrom(nowMs: number): number {
	return Math.floor((nowMs + SIGNED_IMAGE_URL_TTL_MS) / 1000);
}
