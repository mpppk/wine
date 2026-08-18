import {
	IMPERSONATION_READONLY_MESSAGE,
	isImpersonationWriteBlocked,
	isWriteRequest,
} from "#/lib/admin/impersonation";
import { auth } from "#/lib/auth";
import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS_PER_ENTRY,
	maxFormDataBytes,
} from "#/lib/drunk-wine/photo";
import { TOO_MANY_REQUESTS_MESSAGE } from "#/lib/errors";
import { withinRateLimit } from "#/lib/rate-limit";

// formData() はボディ全体をメモリに載せるため、明らかに大きいリクエストはパース前に弾く。
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
interface ApiErrorBody {
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

/**
 * 枚数上限の超過メッセージ。**上限はルートによって違う**(エントリの写真は
 * MAX_PHOTOS_PER_ENTRY、一括登録の解析は MAX_PHOTOS_PER_IMPORT_BATCH)ので、
 * 文言だけを共有して枚数は引数で受ける。
 */
function tooManyPhotosMessage(limit: number): string {
	return `写真は最大${limit}枚までです`;
}

/** 各ルートで共有するエラー文言。上限値は定数から組み立てる(リテラル再記述を作らない)。 */
export const API_ERROR_MESSAGES = {
	unauthorized: "Unauthorized",
	impersonationReadOnly: IMPERSONATION_READONLY_MESSAGE,
	invalidFormData: "Invalid form data",
	unsupportedImageType: "Unsupported image type",
	fileTooLarge: `File exceeds ${MAX_PHOTO_SIZE_LABEL} limit`,
	filesTooLarge: "Files exceed size limit",
	tooManyPhotos: tooManyPhotosMessage(MAX_PHOTOS_PER_ENTRY),
	noPhoto: "No photo file provided",
} as const;

/** エントリ写真の枚数(既定)を前提とした上限。 */
export const MAX_FORM_DATA_BYTES = maxFormDataBytes(MAX_PHOTOS_PER_ENTRY);

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
	// 書き込み(=このルート群では画像アップロード)のスロットル(#397)。R2 への書き込みは
	// オーナー負担の従量コストなので、server function 側とは別枠・別上限で絞る。
	// server function 側(src/server/middleware.ts)と同じく userId をキーにする。
	if (
		isWriteRequest(request.method) &&
		!(await withinRateLimit("upload", session.user.id, {
			userId: session.user.id,
			path: new URL(request.url).pathname,
		}))
	) {
		return apiJsonError(TOO_MANY_REQUESTS_MESSAGE, 429);
	}
	return session;
}

/**
 * ボディを読みながら上限バイト数で打ち切るリクエストを作る。
 *
 * `exceeded()` は「上限超過で打ち切ったか」を返す。ストリームのエラーは
 * `formData()` の例外として出てくるが、**例外の型・メッセージはランタイム依存**なので
 * 種類の判別には使わず、このフラグで見る。
 */
function withBodyLimit(
	request: Request,
	limit: number,
): { request: Request; exceeded: () => boolean } {
	const body = request.body;
	// ボディの無いリクエストは打ち切りようがない(formData() 側が 400 にする)。
	if (!body) return { request, exceeded: () => false };

	let seen = 0;
	let over = false;
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (over) return;
			seen += chunk.byteLength;
			if (seen > limit) {
				over = true;
				// **error ではなく terminate で打ち切る**。error にすると下流に例外が伝播する
				// 経路が増え、どこかで未処理の rejection としてランタイムに漏れて
				// 「超過リクエストのたびにエラーログが出る」(攻撃者が任意に量産できる
				// ログノイズになる)。terminate なら下流は「本文が途中で終わった」だけを見る。
				// 打ち切ったかどうかは over フラグで判る。
				controller.terminate();
				return;
			}
			controller.enqueue(chunk);
		},
	});

	// 打ち切り時は書き込み側が閉じ、pipeTo は reject して上流の読み取りをキャンセルする
	// (= 上限を超えたバイトはメモリに載らない)。その reject は想定内なので握りつぶす。
	void body.pipeTo(writable).catch(() => {});

	return {
		request: new Request(request.url, {
			method: request.method,
			// multipart の boundary を含む content-type を保つ(無いとパースできない)。
			headers: request.headers,
			body: readable,
			// ストリームをボディにする場合に必須。workerd の型には無いが、
			// Request の初期化オプションとしては受け付ける。
			duplex: "half",
		} as RequestInit),
		exceeded: () => over,
	};
}

/**
 * サイズ上限つきで FormData をパースする。超過なら 413、パース失敗なら 400 の
 * Response を返す。
 *
 * **Content-Length は信用できない**(#398)。`Transfer-Encoding: chunked` の POST には
 * そもそもヘッダが無く、以前の実装は `Number(null ?? 0)` = 0 として素通しし、
 * `request.formData()` が本文全体(Cloudflare の上限 100MB まで)を 128MB の isolate
 * メモリへバッファしていた。ファイル単位の検証(`validateDeclaredPhotoFile`)はバッファ後に
 * しか走らないため、並行して大きな chunked アップロードを投げれば isolate の OOM を誘発でき、
 * 同居する処理中リクエストを巻き込めた。
 *
 * そこで**実際に流れたバイト数**を数えて上限で打ち切る。Content-Length のチェックは
 * ボディを一切読まずに弾ける早期リターンとして残す(申告が正しい通常のクライアント向け)。
 */
export async function readImageFormData(
	request: Request,
	maxPhotos: number = MAX_PHOTOS_PER_ENTRY,
): Promise<FormData | Response> {
	const limit = maxFormDataBytes(maxPhotos);

	// 申告値が既に超過なら、ボディを読まずに弾く(正直なクライアントの早期リターン)。
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > limit) {
		return apiJsonError(API_ERROR_MESSAGES.filesTooLarge, 413);
	}

	// 申告が無い/過少申告でも、実バイト数がここを超えたら読むのをやめる。
	const limited = withBodyLimit(request, limit);
	let form: FormData;
	try {
		form = await limited.request.formData();
	} catch {
		// 打ち切った本文は multipart として不完全なのでパースに失敗するのが通常。
		// 「大きすぎた」と「壊れていた」を取り違えないよう、フラグで区別する。
		return limited.exceeded()
			? apiJsonError(API_ERROR_MESSAGES.filesTooLarge, 413)
			: apiJsonError(API_ERROR_MESSAGES.invalidFormData, 400);
	}
	// パースが成功しても、打ち切っていれば内容は途中まで。切れ目がパート境界と偶然
	// 一致した場合にここへ来るので、成功側でも必ず確かめる(中途半端な FormData を
	// 正常な入力として下流へ通さない)。
	if (limited.exceeded()) {
		return apiJsonError(API_ERROR_MESSAGES.filesTooLarge, 413);
	}
	return form;
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

/**
 * FormData の "photo" を取り出し、「1枚以上・上限枚数以下・MIME/サイズが妥当」まで
 * 検証して返す。問題があれば Response を返すので、呼び出し側は `instanceof Response` で
 * そのまま return する。
 *
 * AI解析系のルート(エチケット解析 / 一括抽出)がこの3点セットを個別に書くと、
 * 4本目を足すときに枚数チェックだけ漏れる形になる(この関門を作った #260 と同じ動機)。
 * 上限枚数はルートで違うので引数で受ける。
 */
export function readPhotoFiles(
	formData: FormData,
	maxPhotos: number = MAX_PHOTOS_PER_ENTRY,
): File[] | Response {
	const files = formData
		.getAll("photo")
		.filter((f): f is File => f instanceof File);
	if (files.length === 0) return apiJsonError(API_ERROR_MESSAGES.noPhoto, 400);
	if (files.length > maxPhotos) {
		return apiJsonError(tooManyPhotosMessage(maxPhotos), 400);
	}
	const invalid = validateDeclaredPhotoFiles(files);
	if (invalid) return invalid;
	return files;
}

/**
 * 画像ファイルを data URI に変換する(AIプロバイダへ渡す形)。btoa はチャンクで呼び、
 * 巨大文字列の一括連結を避ける。
 *
 * **申告 MIME をそのまま載せる**のは、この先が R2 への保存ではなく AI への入力に限られる
 * ため(保存する Content-Type は resolveStoredPhotoMime が実バイトから確定する #150)。
 */
