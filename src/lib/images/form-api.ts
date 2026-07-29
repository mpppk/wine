import {
	IMPERSONATION_READONLY_MESSAGE,
	isImpersonationWriteBlocked,
} from "#/lib/admin/impersonation";
import { auth } from "#/lib/auth";
import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS_PER_ENTRY,
} from "#/lib/drunk-wine/photo";

// FormData で画像を受け取る API ルート(アバター / ワイン写真 / エチケット解析)の共通関門(#260)。
//
// 3ルートは「セッション確認 → サイズ前チェック → formData パース → MIME/サイズ検証」という
// 同じ骨格を各自実装しており、jsonError も上限の式もエラー文言も複製されていた。4本目を足す
// ときに検証・上限・エラー形式のどれかが漏れる形で、#174(MIME検証がワイン写真経路に未適用)と
// 同じ再演になる。ここを通す限り漏れない、という関門にする。
//
// server fn(src/server/*)は middleware で同じ役割を果たしているが、こちらは Web 標準の
// Request/Response を直接扱う別系統(docs/architecture.md「サーバーへの入口は3系統」)なので
// 共有しない。

/** エラー応答の本文形。3ルートで同一(クライアントは body.error を読む)。 */
export interface ApiErrorBody {
	error: string;
}

export function apiJson(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function apiJsonError(message: string, status: number): Response {
	return apiJson({ error: message } satisfies ApiErrorBody, status);
}

/** 3ルートで共有するエラー文言。上限値は定数から組み立てる(リテラル再記述を作らない)。 */
export const API_ERROR_MESSAGES = {
	unauthorized: "Unauthorized",
	impersonationReadOnly: IMPERSONATION_READONLY_MESSAGE,
	invalidFormData: "Invalid form data",
	unsupportedImageType: "Unsupported image type",
	fileTooLarge: `File exceeds ${MAX_PHOTO_SIZE_LABEL} limit`,
	filesTooLarge: "Files exceed size limit",
	tooManyPhotos: `写真は最大${MAX_PHOTOS_PER_ENTRY}枚までです`,
} as const;

/**
 * formData() はボディ全体をメモリに載せるため、明らかに大きいリクエストはパース前に弾く。
 * 全枚数ぶん + multipart 境界等のオーバーヘッドを見込む。
 */
export const MAX_FORM_DATA_BYTES =
	MAX_PHOTO_BYTES * MAX_PHOTOS_PER_ENTRY + 64 * 1024;

/**
 * ログイン中のセッションを返す。未ログインなら 401、なりすまし(impersonation)中の
 * 書き込みなら 403 の Response を返すので、呼び出し側は `instanceof Response` で
 * そのまま return する。
 *
 * なりすまし中の書き込み拒否は server function 側(`src/server/middleware.ts`)と
 * 同じ判定関数を共有する。この3ルートはすべて POST(画像アップロード)なので、
 * ここを通す限りなりすまし中に対象ユーザの R2 オブジェクトや AI クレジットが
 * 動くことはない(#116)。
 */
export async function requireApiSession(
	request: Request,
): Promise<
	NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>> | Response
> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) return apiJsonError(API_ERROR_MESSAGES.unauthorized, 401);
	if (isImpersonationWriteBlocked(session, request.method)) {
		return apiJsonError(API_ERROR_MESSAGES.impersonationReadOnly, 403);
	}
	return session;
}

/**
 * サイズ前チェック込みで FormData をパースする。超過なら 413、パース失敗なら 400 の
 * Response を返す。
 */
export async function readImageFormData(
	request: Request,
): Promise<FormData | Response> {
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > MAX_FORM_DATA_BYTES) {
		return apiJsonError(API_ERROR_MESSAGES.filesTooLarge, 413);
	}
	try {
		return await request.formData();
	} catch {
		return apiJsonError(API_ERROR_MESSAGES.invalidFormData, 400);
	}
}

/**
 * 申告 MIME と 1ファイルのサイズを検証する。問題があれば 400 の Response を返す。
 *
 * **これは前段の足切りにすぎない**。保存する Content-Type は実バイトから確定する
 * (`resolveStoredPhotoMime`)。申告値だけで通してはならない(#150)。
 */
export function validateDeclaredPhotoFile(file: File): Response | null {
	if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
		return apiJsonError(API_ERROR_MESSAGES.unsupportedImageType, 400);
	}
	if (file.size > MAX_PHOTO_BYTES) {
		return apiJsonError(API_ERROR_MESSAGES.fileTooLarge, 400);
	}
	return null;
}

/** 複数ファイル版。最初に見つかった問題の Response を返す。 */
export function validateDeclaredPhotoFiles(
	files: readonly File[],
): Response | null {
	for (const file of files) {
		const error = validateDeclaredPhotoFile(file);
		if (error) return error;
	}
	return null;
}
