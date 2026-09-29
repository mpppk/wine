import {
	MAX_PHOTO_BYTES,
	resolveStoredPhotoMime,
} from "#/lib/drunk-wine/photo";
import { logWarn } from "#/lib/logger";
import { isAllowedExternalHost } from "#/lib/net/ssrf-guard";

// web上の画像URLから写真を1枚取り込む(Issue #473)。一括登録で「その銘柄の適切な写真が
// 手元に無い」ときに、解析が見つけたボトル/エチケットの画像を取りに行くための唯一の入口。
//
// **URLはモデルの出力**であり、クライアント経由で戻ってくる。つまり保存先(自分のR2)は
// 自分のものでも、**取得先は第三者が実質的に指定できる**。ここは「サーバに任意のURLを
// 叩かせる」機能そのものなので、関門をこの1モジュールに閉じる:
//
//  - https のみ(http・data:・blob: 等は拒否)。平文の取得は中間者に差し替えられる
//  - ホスト判定は共通チョークポイント(`isAllowedExternalHost`、既定の厳しい側)に
//    寄せる。Workers 前提の判断はあちらに一元化し、ここでは持ち直さない(#545)
//  - リダイレクトは `redirect: "manual"` で1ホップずつ辿り、毎回ホストを再検証
//    する(#148 と同等。初回URLだけ検証して内部アドレスへ素通しさせない)
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

/** 追跡するリダイレクトの最大ホップ数。これを超えたら取得を諦める。 */
const MAX_REDIRECTS = 5;

/** 取得してよいURLか。文字列を検証して URL を返す(不可なら undefined)。 */
export function parseRemotePhotoUrl(raw: string): URL | undefined {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	// ホスト判定は共通ガードの既定(厳しい側: IPリテラルは公開IPでも拒否)に寄せる。
	if (!url.hostname || !isAllowedExternalHost(url.hostname)) return undefined;
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
	let current = parseRemotePhotoUrl(rawUrl);
	if (!current) {
		logWarn("remote photo url rejected", { ...fields, url: rawUrl });
		return undefined;
	}

	let response: Response | undefined;
	try {
		// リダイレクトは follow せず manual で1ホップずつ辿り、毎回 SSRF ガードで
		// 再検証する。follow だと初回URLだけ検証してリダイレクト先(内部アドレス)を
		// 素通ししてしまう(#148 と同じ穴)。最終バイトのMIME判定(resolveStoredPhotoMime
		// が実バイトから確定)は「保存されるもの」の安全を担い、こちらは「内部アドレスへ
		// リクエストが飛ぶこと自体」を塞ぐ。両輪である。
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
			if (current.protocol !== "https:") {
				logWarn("remote photo redirect rejected", {
					...fields,
					url: current.href,
				});
				return undefined;
			}
			if (!isAllowedExternalHost(current.hostname)) {
				logWarn("remote photo redirect rejected", {
					...fields,
					url: current.href,
				});
				return undefined;
			}
			const hop = await fetch(current, {
				redirect: "manual",
				headers: { accept: "image/*" },
				signal: AbortSignal.timeout(REMOTE_PHOTO_TIMEOUT_MS),
			});
			if (hop.status >= 300 && hop.status < 400) {
				const location = hop.headers.get("location");
				// 中間レスポンスのボディは読み捨てて接続を解放する
				await hop.body?.cancel().catch(() => {});
				if (!location) {
					logWarn("remote photo redirect without location", {
						...fields,
						url: current.href,
						status: hop.status,
					});
					return undefined;
				}
				try {
					current = new URL(location, current);
				} catch {
					logWarn("remote photo redirect rejected", {
						...fields,
						url: current.href,
					});
					return undefined;
				}
				continue;
			}
			response = hop;
			break;
		}
	} catch (err) {
		logWarn("remote photo fetch failed", { ...fields, url: current.href, err });
		return undefined;
	}
	if (!response) {
		logWarn("remote photo too many redirects", {
			...fields,
			url: current.href,
		});
		return undefined;
	}
	if (!response.ok) {
		logWarn("remote photo fetch not ok", {
			...fields,
			url: current.href,
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
		logWarn("remote photo too large or empty", {
			...fields,
			url: current.href,
		});
		return undefined;
	}

	const mimeType = declared
		? resolveStoredPhotoMime(bytes, declared)
		: undefined;
	if (!mimeType) {
		// 画像を装ったHTML・許可外の形式(SVG等)・申告と実体の食い違い。
		logWarn("remote photo rejected by mime check", {
			...fields,
			url: current.href,
			declared,
		});
		return undefined;
	}
	return { bytes, mimeType, url: current.href };
}
