import { z } from "zod";

// updateUser / sign-up の image・name の検証と、管理画面の表示ガードの単一情報源(#636)。
//
// `authClient.updateUser` と sign-up は better-auth のハンドラ直結でアプリ側の
// server fn zod を通らないため、image に任意の外部URLを保存できてしまう(#256 と
// 同じ構図)。管理画面が `<img src={u.image}>` で描画する(BasicInfoCard・
// admin.index)ため、外部URLは管理者の閲覧時に攻撃者サーバへのリクエスト(時刻・
// IP・UA の漏洩)になる。書き込み側の関門(hooks.before)と表示側のガードの双方が
// このモジュールを引く。

/** 表示名の最大文字数。PLACE_NAME_MAX(100)に揃える。 */
export const USER_NAME_MAX = 100;

/**
 * 表示名の検証スキーマ。**書き込み経路(better-auth の hooks.before)と
 * 読み取り不要の表示側ではなく境界だけが使う SSOT**(#256 の
 * regionQaModelKeySchema と同じ形)。エラーメッセージは better-auth が 400 の
 * message にそのまま載せ、プロフィール画面に表示されるため日本語にする。
 */
export const userNameSchema = z
	.string()
	.trim()
	.min(1, { error: "名前を入力してください。" })
	.max(USER_NAME_MAX, {
		error: `名前は${USER_NAME_MAX}文字以内で入力してください。`,
	});

/**
 * アバター配信で使う画像拡張子。許可MIMEの正は
 * `#/lib/drunk-wine/photo` の PHOTO_FORMATS にあり、保存時の拡張子もそこから
 * 決まる(photoExtForMime)。ここでは URL の照合に要る ext 側だけを並べる。
 */
const AVATAR_IMAGE_EXTS = "jpg|png|webp|gif";

/** RegExp 組み立て用。userId(nanoid 系)をリテラルとして埋め込む。 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 自分のアバター配信パスかどうか。/api/upload が返す
 * `/api/images/avatars/{userId}.{ext}?v=<数字>` の形だけを通す。
 * null/undefined(未設定・削除)は対象外なので扱わない — 呼び出し側で分ける。
 */
export function isOwnAvatarImage(value: unknown, userId: string): boolean {
	if (typeof value !== "string" || userId === "") return false;
	const pattern = new RegExp(
		`^/api/images/avatars/${escapeRegExp(userId)}\\.(?:${AVATAR_IMAGE_EXTS})\\?v=\\d+$`,
	);
	return pattern.test(value);
}

/**
 * 管理画面で `<img>` 描画してよいアバター値かどうか(多層防御の表示側)。
 * 書き込み側を通り抜けた外部URL・既存行に残る OAuth 由来の外部URLを描画しない。
 * 自オリジンの相対パスかつ avatars 配下の画像ファイルだけを通す。
 */
export function isDisplayableAvatarImage(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return new RegExp(
		`^/api/images/avatars/[A-Za-z0-9_-]+\\.(?:${AVATAR_IMAGE_EXTS})(\\?[^#]*)?$`,
	).test(value);
}
