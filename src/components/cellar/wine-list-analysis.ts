import { postImageForm } from "#/lib/images/form-client";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";

// 一括登録のバッチ写真をアップロードするクライアント側ヘルパー(Issue #358)。
//
// **解析そのものはここには無い**(#480)。写真からの一括抽出はジョブ経路
// (`label-analysis.ts` の `submitLabelAnalysisJob`)へ移り、同期APIは削除した。
// 残っているのは「登録が確定した後にバッチの写真の実体を送る」2段階目だけ。
//
// **その2段階目も通常は通らない**(#617)。解析の投入時点で写真は既にサーバ(R2)に
// あるので、確定後はジョブからバッチへ引き継ぐ。アップロードは引き継げなかったときの
// フォールバックで、どちらを使うかは `resolveBatchPhotoFallback` が決める。
//
// 通信失敗・非JSON応答・送信前のサイズガードは postImageForm(images/form-client.ts)に
// 寄せてある。ここで fetch を直に書かないこと。

/**
 * ジョブからの引き継ぎが空だったときに、手元の写真を送ってよいか。
 *
 * - `"none"` … 送るものが無い(引き継げた回・そもそも手元に写真が無い回)
 * - `"upload"` … 手元の写真を送る
 * - `"unavailable"` … 送ってはいけない。手元の写真が**解析に使ったものと枚数が違う**
 *   ので、候補の `photoIndexes` が指す先とズレる。写真なしで記録を残す方が害が小さい
 *
 * 引き継ぎが空になるのは、受け取り済みから24時間経って `sweepConsumedJobPhotos` が
 * 写真を回収した後に登録した回など。**登録そのものは既に済んでいる**ので、ここでの
 * 判定は「写真を足せるか」だけを決める。
 */
export function resolveBatchPhotoFallback(input: {
	/** ジョブからバッチへ引き継げた枚数 */
	adopted: number;
	/** 手元にある写真の枚数 */
	localCount: number;
	/** 解析に使った写真の枚数。まだ解析していなければ null */
	analyzedCount: number | null;
}): "none" | "upload" | "unavailable" {
	if (input.adopted > 0 || input.localCount === 0) return "none";
	if (
		input.analyzedCount !== null &&
		input.localCount !== input.analyzedCount
	) {
		return "unavailable";
	}
	return "upload";
}

/** 一括登録の確定後に、バッチの写真の実体をアップロードする(2段階目)。 */
export async function uploadImportBatchPhotos(
	batchId: string,
	files: File[],
): Promise<void> {
	if (files.length === 0) return;
	const form = new FormData();
	form.append("batchId", batchId);
	// 保存する写真は原寸のまま送る(解析用の縮小は解析にだけ使う。マイセラーの
	// 写真アップロードと同じ方針)
	for (const file of files) form.append("photo", file);
	await postImageForm("/api/import-batch-photos", form, {
		fallbackMessage: "写真の保存に失敗しました",
		maxPhotos: MAX_PHOTOS_PER_IMPORT_BATCH,
	});
}
