import {
	ALLOWED_PHOTO_TYPES,
	PHOTO_FORMATS_LABEL_JA,
} from "#/lib/drunk-wine/photo";

// 一括登録履歴からの再解析(Issue #427)で、保存済みのバッチ写真を読み直すヘルパー。
//
// **署名URLは使わない**。バッチ写真は `wines/{userId}/{batchId}/...` に置かれていて、
// 配信ルートが本人セッションで認可する(images/signed-url.ts の認可経路1)。再解析は
// アプリ内のログイン済み画面から走るので、same-origin の fetch がそのまま通る。
// 署名URLはCookieが乗らない経路(MCP・埋め込みビュー)のためのもので、ここでは要らない。
//
// 取り出した File はそのまま既存の解析経路(submitLabelAnalysisJob → downscaleForAnalysis)
// と登録後の写真アップロードに渡す。**新しいバッチは自分の写真の実体を持つ**
// (元バッチと共有しない)ので、どちらを取り消してももう一方の写真は残る。

/** 相対URLの末尾から拡張子つきのファイル名を作る(無ければ連番で補う)。 */
function fileNameFor(url: string, index: number): string {
	const last = url.split("?")[0]?.split("/").pop();
	return last && last.includes(".") ? last : `batch-photo-${index + 1}.jpg`;
}

/**
 * バッチ写真のURL配列を File 配列にする。**順序を保つ**のが要点で、この順が
 * 目撃記録の photoIndex が指す順になる(並びが崩れると「別の写真で見かけた」ことになる)。
 *
 * 1枚でも取得できなければ throw する。欠けたまま解析すると、抜けた写真に写っていた
 * 銘柄だけが黙って落ちた結果を「再解析の結果」として見せることになる。
 */
export async function fetchBatchPhotoFiles(
	photoUrls: string[],
): Promise<File[]> {
	const files: File[] = [];
	for (const [index, url] of photoUrls.entries()) {
		const res = await fetch(url, { credentials: "same-origin" });
		if (!res.ok) {
			throw new Error("保存済みの写真を読み込めませんでした");
		}
		const blob = await res.blob();
		// 保存時に実バイトからMIMEを確定しているので通常は通る。壊れた古いデータや
		// 配信側の Content-Type 欠落で弾かれた場合は、原因が分かる文言にする。
		if (!ALLOWED_PHOTO_TYPES.has(blob.type)) {
			throw new Error(
				`保存済みの写真の形式を扱えません(${PHOTO_FORMATS_LABEL_JA})`,
			);
		}
		files.push(new File([blob], fileNameFor(url, index), { type: blob.type }));
	}
	return files;
}
