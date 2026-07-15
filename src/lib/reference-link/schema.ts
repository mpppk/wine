import { z } from "zod";

// 参考リンク(村・畑・地方・シャトーごと)の入力バリデーション。server fn から使う
// ため、ランタイム依存(DB/fetch)を持たない純粋な zod パーツに保つ。AOPの存在検証は
// 静的マスタ照合が必要なのでサービス層(reference-link-service)で行う。

/** http/https のみ許可する。javascript: 等のスキームを弾き、xssの入口を作らない */
function isHttpUrl(u: string): boolean {
	try {
		const { protocol } = new URL(u);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export const referenceLinkFields = {
	aopId: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.max(80),
	url: z
		.url()
		.max(2048)
		.refine(isHttpUrl, "http/https のURLのみ対応しています"),
	// 省略時はサービス層がリンク先ページから自動取得する
	title: z.string().trim().min(1).max(200).optional(),
};

export const createReferenceLinkInput = z.object({
	aopId: referenceLinkFields.aopId,
	url: referenceLinkFields.url,
	title: referenceLinkFields.title,
});

// 更新は id のみ必須。url は指定時のみ差し替え。title は null で「未指定に戻す」
// (=次の解決でページから再取得する)意にする。
export const updateReferenceLinkInput = z.object({
	id: z.string().min(1).max(80),
	url: referenceLinkFields.url.optional(),
	title: referenceLinkFields.title.nullable().optional(),
});

export const listReferenceLinksInput = z.object({
	aopId: referenceLinkFields.aopId,
});

export const deleteReferenceLinkInput = z.object({
	id: z.string().min(1).max(80),
});

export type CreateReferenceLinkInput = z.infer<typeof createReferenceLinkInput>;
export type UpdateReferenceLinkInput = z.infer<typeof updateReferenceLinkInput>;
