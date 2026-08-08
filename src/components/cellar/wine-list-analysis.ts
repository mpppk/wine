import { postImageForm } from "#/lib/images/form-client";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";

// 一括登録のバッチ写真をアップロードするクライアント側ヘルパー(Issue #358)。
//
// **解析そのものはここには無い**(#480)。写真からの一括抽出はジョブ経路
// (`label-analysis.ts` の `submitLabelAnalysisJob`)へ移り、同期APIは削除した。
// 残っているのは「登録が確定した後にバッチの写真の実体を送る」2段階目だけ。
//
// 通信失敗・非JSON応答・送信前のサイズガードは postImageForm(images/form-client.ts)に
// 寄せてある。ここで fetch を直に書かないこと。

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
