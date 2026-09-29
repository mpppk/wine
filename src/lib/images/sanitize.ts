import { env } from "cloudflare:workers";
import { stripImageMetadata } from "#/lib/drunk-wine/photo";
import { avatarPrefixForUser } from "#/lib/images/signed-url";
import { isImageTransformAvailable } from "#/lib/images/transform";
import { logError, logWarn } from "#/lib/logger";

// アバター画像の保存前処理(#641)。アバターは無認証の公開配信なので、GPS等の
// EXIFをサーバ側で必ず落とす。クライアント側の再エンコードだけに頼らない
// (直接APIを叩く経路がある)。
//
// 第一経路は IMAGES バインディングでの再エンコードで、メタデータ除去に加えて
// EXIF回転の正規化と上限縮小が効く。無い環境(dev等)・失敗時は可逆な除去
// (`stripImageMetadata`)へフォールバックする(向きは最小EXIFに残して表示を保つ)。
// どちらの経路でも「生バイトのまま保存」はしない。

/** アバター画像の長辺上限(px)。公開プロフィール(表示64px程度)に原寸5MBを置かない。 */
export const AVATAR_MAX_DIMENSION = 512;

/**
 * IMAGESの出力形式。保存MIMEと同じ形式で再エンコードする。
 * GIFだけ対象外にする: アニメGIFを再エンコードすると静止画化・ループ消失の
 * おそれがあり、可逆な除去(stripImageMetadataはアニメを保つ)のほうが安全なため。
 */
function imagesOutputFormat(
	mime: string,
): "image/jpeg" | "image/png" | "image/webp" | undefined {
	switch (mime) {
		case "image/jpeg":
			return "image/jpeg";
		case "image/png":
			return "image/png";
		case "image/webp":
			return "image/webp";
		default:
			return undefined;
	}
}

/**
 * アバター画像を公開保存してよい形にする。メタデータ(GPS等)の除去済みバイト列を
 * 返す。形式は変わらない。
 */
export async function sanitizeAvatarImage(
	bytes: Uint8Array,
	mime: string,
): Promise<Uint8Array> {
	const format = imagesOutputFormat(mime);
	if (format && isImageTransformAvailable()) {
		try {
			// Blob は ArrayBuffer 具体型を要求するため複写する(最大5MB・保存時1回のみ)
			const copy = new Uint8Array(bytes);
			const result = await env.IMAGES.input(
				new Blob([copy]).stream() as ReadableStream<Uint8Array>,
			)
				.transform({
					width: AVATAR_MAX_DIMENSION,
					height: AVATAR_MAX_DIMENSION,
					fit: "scale-down",
				})
				.output({ format });
			const clean = new Uint8Array(await result.response().arrayBuffer());
			if (clean.length > 0) return clean;
			logWarn("avatar sanitize: empty transform output; falling back", {
				mime,
			});
		} catch (e) {
			logWarn("avatar sanitize via IMAGES failed; falling back", {
				mime,
				err: e,
			});
		}
	}
	return stripImageMetadata(bytes);
}

/**
 * 同ユーザの旧アバター(他拡張子)を削除する。キーが `avatars/{userId}.{ext}` のため、
 * png→jpgと差し替えると旧pngが残り、旧URLから配信され続ける(「消したつもりの
 * 写真」が残る)。保存済みの新キーは残す。
 *
 * best-effort: 新アバターの保存自体は済んでいるので、掃除の失敗で500にしない。
 * 消し残しは退会時の一括削除(`avatarPrefixForUser`起点)で拾われる。
 */
export async function deleteStaleAvatars(
	userId: string,
	keepKey: string,
): Promise<void> {
	try {
		const listed = await env.AVATARS.list({
			prefix: avatarPrefixForUser(userId),
		});
		const stale = listed.objects
			.map((o) => o.key)
			.filter((key) => key !== keepKey);
		if (stale.length > 0) await env.AVATARS.delete(stale);
	} catch (e) {
		logError("avatar stale cleanup failed", { userId, keepKey, err: e });
	}
}
