import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	PHOTO_FORMATS_LABEL_JA,
} from "#/lib/drunk-wine/photo";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";

// 一括登録ウィザードの写真選択の受け入れ判定(Issue #428 で切り出し)。
//
// **枚数の上限は「今ある枚数 + これから足す枚数」で見る**。履歴からの再解析(#427)は
// 保存済みの写真が既に入った状態で始まり、そこへ撮り忘れたページを足せるので、
// 「選んだファイルだけ」で判定すると上限を超える。
//
// サーバ側の 400 を待たずにここで弾くが、制約の値は photo.ts / place/schema.ts と
// 共有する(UIとサーバで上限がドリフトしない)。

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
 */
export function acceptPhotoFiles(
	files: readonly File[],
	currentCount: number,
): PhotoAcceptance<File> {
	const accepted: File[] = [];
	let rejectMessage = "";
	let remaining = MAX_PHOTOS_PER_IMPORT_BATCH - currentCount;
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
			rejectMessage = `写真は最大${MAX_PHOTOS_PER_IMPORT_BATCH}枚までです`;
			continue;
		}
		accepted.push(file);
		remaining -= 1;
	}
	return { accepted, rejectMessage };
}

/** あと何枚追加できるか(負にはならない)。 */
export function remainingPhotoSlots(currentCount: number): number {
	return Math.max(0, MAX_PHOTOS_PER_IMPORT_BATCH - currentCount);
}
