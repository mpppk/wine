import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	PHOTO_FORMATS_LABEL_JA,
} from "#/lib/drunk-wine/photo";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";

// 端末から写真を選ぶ経路の共通処理(Issue #428 で切り出し、#469 で全経路に広げた)。
//
// **枚数の上限は「今ある枚数 + これから足す枚数」で見る**。履歴からの再解析(#427)は
// 保存済みの写真が既に入った状態で始まり、そこへ撮り忘れたページを足せるので、
// 「選んだファイルだけ」で判定すると上限を超える。
//
// サーバ側の 400 を待たずにここで弾くが、制約の値は photo.ts / place/schema.ts と
// 共有する(UIとサーバで上限がドリフトしない)。上限の**枚数**だけは経路ごとに違う
// (記録は MAX_PHOTOS_PER_ENTRY、まとめて登録は MAX_PHOTOS_PER_IMPORT_BATCH)ので
// 引数で受ける——判定そのものを経路ごとに書くと、#469 の取り込みのような後付けが
// 片方だけに入る。

/** 受け入れ判定の結果。 */
export interface PhotoAcceptance<T> {
	/** 受け入れたファイル(選択順)。 */
	accepted: T[];
	/**
	 * 弾いた理由。**最後の1件だけ**を返す(理由ごとに列挙すると、複数ファイルを
	 * 選んだときにメッセージが積み上がって読めなくなる)。何も弾かなければ空文字。
	 */
	rejectMessage: string;
}

/**
 * 選択されたファイルのうち、形式・サイズ・残り枚数の条件を満たすものを受け入れる。
 *
 * @param files 選択されたファイル(選択順)
 * @param currentCount 既に選択済みの枚数(再解析で読み込んだ保存済み写真を含む)
 * @param maxPhotos この経路の枚数上限
 */
export function acceptPhotoFiles(
	files: readonly File[],
	currentCount: number,
	maxPhotos: number = MAX_PHOTOS_PER_IMPORT_BATCH,
): PhotoAcceptance<File> {
	const accepted: File[] = [];
	let rejectMessage = "";
	let remaining = maxPhotos - currentCount;
	for (const file of files) {
		if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
			rejectMessage = `対応していない画像形式です(${PHOTO_FORMATS_LABEL_JA})`;
			continue;
		}
		if (file.size > MAX_PHOTO_BYTES) {
			rejectMessage = `写真は${MAX_PHOTO_SIZE_LABEL}以下にしてください`;
			continue;
		}
		if (remaining <= 0) {
			rejectMessage = `写真は最大${maxPhotos}枚までです`;
			continue;
		}
		accepted.push(file);
		remaining -= 1;
	}
	return { accepted, rejectMessage };
}

/** あと何枚追加できるか(負にはならない)。 */
export function remainingPhotoSlots(
	currentCount: number,
	maxPhotos: number = MAX_PHOTOS_PER_IMPORT_BATCH,
): number {
	return Math.max(0, maxPhotos - currentCount);
}

/** 選択時点で中身を読めなかったときの文言。**回線の話ではない**ので分けて出す。 */
export const PHOTO_UNREADABLE_MESSAGE =
	"写真を読み込めませんでした。端末に保存されている写真を選び直してください(クラウド上の写真は選べないことがあります)。";

/**
 * 選択したファイルの中身を**その場でメモリへ取り込む**(Issue #469)。
 *
 * `<input type="file">` が返す `File` は端末のファイルへの**参照**でしかない。Android で
 * 写真アプリ(コンテンツプロバイダ)経由で選んだ写真は一時領域に置かれ、しばらくすると
 * 回収される。そのあとに `File` を body にすると読み取りが失敗し、**リクエストは1バイトも
 * 送られないまま** `fetch` が `TypeError` を投げる——利用者には
 * 「通信に失敗しました」としか見えず、サーバ側にはログすら残らない。
 *
 * 解析だけが通っていたのは、解析経路が選択直後に canvas で再エンコードした**メモリ上の
 * Blob** を送っていたからで(`downscaleForAnalysis`)、原寸をそのまま保存する経路だけが
 * 数十秒〜数分後の読み取りになっていた。**選んだ瞬間なら必ず読める**ので、そこで実体を
 * 掴んでしまえば以後は端末側の都合から切り離せる。
 *
 * 載る量は既存の上限(1枚 {@link MAX_PHOTO_BYTES} × 経路ごとの枚数上限)で頭打ちになる。
 * `new File([bytes], …)` の実体はブラウザの Blob ストレージへ移るので、JSヒープを
 * 持ち続けるわけではない。
 *
 * 読めなかったファイルは**落として理由を返す**。ここで落ちるのは本当に端末側の問題で、
 * 送信時まで持ち越しても直らない(むしろ「通信の失敗」に化けて原因が見えなくなる)。
 */
export async function detachPhotoFiles(
	files: readonly File[],
): Promise<PhotoAcceptance<File>> {
	const accepted: File[] = [];
	let rejectMessage = "";
	for (const file of files) {
		try {
			const bytes = await file.arrayBuffer();
			accepted.push(
				new File([bytes], file.name, {
					type: file.type,
					lastModified: file.lastModified,
				}),
			);
		} catch {
			rejectMessage = PHOTO_UNREADABLE_MESSAGE;
		}
	}
	return { accepted, rejectMessage };
}
