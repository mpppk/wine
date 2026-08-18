import {
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS_PER_ENTRY,
	maxFormDataBytes,
} from "#/lib/drunk-wine/photo";
import { reportClientError } from "#/lib/observability/client-error";

// 画像を FormData で POST するクライアント側の共通関門。サーバ側の関門
// (images/form-api.ts)と対になる存在で、**ブラウザから画像APIを叩く経路は
// すべてここを通す**(アバター / ワイン写真 / エチケット解析 / 一括抽出 /
// 一括登録の写真保存)。
//
// 経路ごとに fetch を直書きすると、次の2つが必ず取りこぼされる:
//  - **レスポンスが返らない通信失敗**。fetch は TypeError を投げ、その message は
//    ブラウザ既定の "Failed to fetch"(Chrome)/"Load failed"(Safari)。これを
//    そのまま画面に出すと、ユーザは何をすればよいか分からない。写真が大きい・
//    枚数が多い・電波が悪いといった**再試行で直る**状況で最も出やすい。
//  - **JSONでないレスポンス**(フレームワークの汎用500やCloudflareのエラーページ)。
//    res.json() が SyntaxError になり "Unexpected token '<'" が表示される。
//
// 送信前のサイズガードも同じ理由でここに置く。サーバの 413 は「レスポンスが返れば」
// 文言を出せるが、モバイル回線では巨大なボディを送り切る前に接続が切れることがあり、
// その場合は 413 すら返らない。送る前に弾けば必ず理由を伝えられる。

/** 通信そのものが失敗した(レスポンスが1バイトも返らなかった)ときの文言。 */
export const NETWORK_ERROR_MESSAGE =
	"通信に失敗しました。写真の枚数を減らすか、電波の良い場所で再試行してください。";

/** 送信前のサイズガードに引っかかったときの文言。 */
function payloadTooLargeMessage(maxPhotos: number): string {
	return `写真の合計サイズが大きすぎて送信できません。枚数を減らす(最大${maxPhotos}枚)か、1枚${MAX_PHOTO_SIZE_LABEL}以下の写真を選んでください。`;
}

/** FormData に載っている File / Blob の合計バイト数。文字列フィールドは誤差として無視する。 */
export function formDataBytes(form: FormData): number {
	let bytes = 0;
	for (const [, value] of form.entries()) {
		if (typeof value !== "string") bytes += value.size;
	}
	return bytes;
}

export interface PostImageFormOptions {
	/** 応答から理由を取り出せなかったときに表示する文言(経路ごとの日本語)。 */
	fallbackMessage: string;
	/** この経路が受け付ける最大枚数。送信前のサイズガードの基準になる。 */
	maxPhotos?: number;
}

/**
 * 画像を含む FormData を同一オリジンの API へ POST し、JSON を返す。
 * 失敗時は**必ずユーザに見せられる日本語の message を持つ Error** を throw する。
 */
export async function postImageForm<T>(
	path: string,
	form: FormData,
	{ fallbackMessage, maxPhotos = MAX_PHOTOS_PER_ENTRY }: PostImageFormOptions,
): Promise<T> {
	if (formDataBytes(form) > maxFormDataBytes(maxPhotos)) {
		throw new Error(payloadTooLargeMessage(maxPhotos));
	}

	let res: Response;
	try {
		res = await fetch(path, { method: "POST", body: form });
	} catch (e) {
		// **サーバには何も残らない失敗**(レスポンスが返らないのでログも出ない)。
		// ここで拾わないと再発時に再び原因不明になるので、収集先へ送る(#381)。
		// 画面に出す文言は行動可能なものに寄せ、原因はコンソールと収集先に残す。
		reportClientError(e, {
			kind: "image_upload_network",
			path,
			bytes: formDataBytes(form),
			photos: form.getAll("photo").length,
		});
		throw new Error(NETWORK_ERROR_MESSAGE);
	}

	const body = await res
		.json()
		.then((json) => json as T & { error?: unknown })
		.catch(() => null);

	if (!res.ok) {
		throw new Error(
			typeof body?.error === "string" ? body.error : fallbackMessage,
		);
	}
	if (body === null) throw new Error(fallbackMessage);
	return body;
}
