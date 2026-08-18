import {
	MAX_PHOTO_BYTES,
	resolveStoredPhotoMime,
} from "#/lib/drunk-wine/photo";
import { logWarn } from "#/lib/logger";

// web上の画像URLから写真を1枚取り込む(Issue #473)。一括登録で「その銘柄の適切な写真が
// 手元に無い」ときに、解析が見つけたボトル/エチケットの画像を取りに行くための唯一の入口。
//
// **URLはモデルの出力**であり、クライアント経由で戻ってくる。つまり保存先(自分のR2)は
// 自分のものでも、**取得先は第三者が実質的に指定できる**。ここは「サーバに任意のURLを
// 叩かせる」機能そのものなので、関門をこの1モジュールに閉じる:
//
//  - https のみ(http・data:・blob: 等は拒否)。平文の取得は中間者に差し替えられる
//  - ホスト名がIPリテラル・localhost・内部向けTLDなら拒否。Workers から社内網へは
//    そもそも到達しないが、**将来この関数が別のランタイムから呼ばれても壊れない**よう、
//    「名前で公開ホストを指している」ことをここで要求する
//  - 取得はタイムアウト付き。1銘柄の画像のために登録の確定を待たせない
//  - 実バイトのサイズ上限(MAX_PHOTO_BYTES)。Content-Length は申告値なので信用せず、
//    読み込んだ実バイトでも確認する
//  - 保存する Content-Type は**実バイトから確定**する(resolveStoredPhotoMime。#150)。
//    HTMLエラーページを .jpg で返すサイトは珍しくないので、申告だけでは通さない
//
// **決して throw しない**。画像が取れないのは想定内(#473 の要件どおり一括登録の写真へ
// フォールバックする)で、ここで例外にすると「写真が取れなかったせいで登録全体が失敗する」
// ことになる。

/** 1枚あたりの取得のタイムアウト。登録の確定を長く待たせない。 */
const REMOTE_PHOTO_TIMEOUT_MS = 8_000;

/** 取り込んだ画像。保存する Content-Type は実バイトから確定済み。 */
export interface RemotePhoto {
	bytes: Uint8Array;
	/** 実バイトから判定した MIME(許可4種のいずれか)。 */
	mimeType: string;
	/** 実際に取得したURL(リダイレクト後)。 */
	url: string;
}

/**
 * 内部向けに見えるホスト名。IPリテラル(v4/v6)と、名前解決が環境依存になる特別名を弾く。
 * ここを通ったホスト名でも公開DNSが内部アドレスを返す可能性は残るが、Workers の fetch は
 * 内部網へ到達しないため、実効的な多層防御としてはこの段で十分。
 */
function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	// IPv6 リテラルは URL 上 [..] で囲まれるが、hostname では括弧が外れる
	if (host.includes(":")) return true;
	// IPv4 リテラル
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
	// 名前解決が環境依存/内部向けの特別用途TLD(RFC 6761 / 8375)
	return /\.(local|internal|localdomain|home\.arpa)$/.test(host);
}

/** 取得してよいURLか。文字列を検証して URL を返す(不可なら undefined)。 */
export function parseRemotePhotoUrl(raw: string): URL | undefined {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	if (!url.hostname || isBlockedHost(url.hostname)) return undefined;
	return url;
}

/**
 * 上限まで読み進めながらバイト列を組み立てる。**上限を超えたら読むのをやめて undefined**。
 * `arrayBuffer()` で丸ごと受けると、Content-Length を偽った応答で isolate のメモリを
 * 消費させられる(FormData 経路の `withBodyLimit` と同じ懸念・同じ対処)。
 */
async function readWithLimit(
	response: Response,
	limit: number,
): Promise<Uint8Array | undefined> {
	const body = response.body;
	if (!body) return undefined;
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * web上の画像を1枚取り込む。取り込めなければ `undefined`(理由は warn ログに残す)。
 *
 * @param rawUrl モデルが見つけた画像のURL。検証はこの関数が行うので、呼び出し側で
 *   先に絞る必要はない。
 * @param fields ログに載せる文脈(userId など)。
 */
export async function fetchRemotePhoto(
	rawUrl: string,
	fields: Record<string, unknown> = {},
): Promise<RemotePhoto | undefined> {
	const url = parseRemotePhotoUrl(rawUrl);
	if (!url) {
		logWarn("remote photo url rejected", { ...fields, url: rawUrl });
		return undefined;
	}

	let response: Response;
	try {
		response = await fetch(url, {
			// リダイレクトの先も同じ検証に掛けたいが、fetch の manual リダイレクトは
			// ランタイム差が大きい。追跡は許し、**最終的に取れたバイトの中身**で
			// 判定する(検証の重心を「どこから来たか」より「何が来たか」に置く)。
			redirect: "follow",
			headers: { accept: "image/*" },
			signal: AbortSignal.timeout(REMOTE_PHOTO_TIMEOUT_MS),
		});
	} catch (err) {
		logWarn("remote photo fetch failed", { ...fields, url: url.href, err });
		return undefined;
	}
	if (!response.ok) {
		logWarn("remote photo fetch not ok", {
			...fields,
			url: url.href,
			status: response.status,
		});
		return undefined;
	}

	// 申告 Content-Type。実バイトとの一致は resolveStoredPhotoMime が要求するので、
	// ここでは media type 部分の切り出しだけを行う("image/jpeg; charset=..." 対策)。
	const declared = (response.headers.get("content-type") ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase();
	const bytes = await readWithLimit(response, MAX_PHOTO_BYTES).catch(() => {
		return undefined;
	});
	if (!bytes || bytes.length === 0) {
		logWarn("remote photo too large or empty", { ...fields, url: url.href });
		return undefined;
	}

	const mimeType = declared
		? resolveStoredPhotoMime(bytes, declared)
		: undefined;
	if (!mimeType) {
		// 画像を装ったHTML・許可外の形式(SVG等)・申告と実体の食い違い。
		logWarn("remote photo rejected by mime check", {
			...fields,
			url: url.href,
			declared,
		});
		return undefined;
	}
	return { bytes, mimeType, url: url.href };
}
