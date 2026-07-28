// アプリ共通のエラー型。フレームワーク非依存の素の Error 派生なので、
// サービス層(#/lib)・サーバ層(#/server)・MCP のどこからでも throw でき、
// 呼び出し境界で HTTPステータスや外部公開可否の判断に使える。

/** HTTPステータスを伴うエラー。server function の境界で 4xx へ写す。 */
export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

/** 認証切れ・未ログイン(401)。 */
export class UnauthorizedError extends HttpError {
	constructor(message = "Unauthorized") {
		super(401, message);
		this.name = "UnauthorizedError";
	}
}

/** 権限不足(403)。認証済みだが操作を許可されていない。 */
export class ForbiddenError extends HttpError {
	constructor(message = "Forbidden") {
		super(403, message);
		this.name = "ForbiddenError";
	}
}

/** クライアント入力起因の不正リクエスト(400)。 */
export class BadRequestError extends HttpError {
	constructor(message = "Bad Request") {
		super(400, message);
		this.name = "BadRequestError";
	}
}

/** 対象リソースが存在しない(404)。 */
export class NotFoundError extends HttpError {
	constructor(message = "Not Found") {
		super(404, message);
		this.name = "NotFoundError";
	}
}

/** 現在の状態と衝突して処理できない(409)。利用済みコード・多重実行など。 */
export class ConflictError extends HttpError {
	constructor(message = "Conflict") {
		super(409, message);
		this.name = "ConflictError";
	}
}

/**
 * server function が throw した HttpError を**クライアント側で**判別する。
 *
 * TanStack Start は throw された値を seroval でシリアライズして返すため
 * (`start-server-core/server-functions-handler.js` の catch)、クライアントが
 * 受け取るのは素の Error で **プロトタイプは失われる**。つまり
 * `error instanceof HttpError` はサーバ境界を越えると必ず false になる。
 * 一方 `name` と own プロパティの `status` は保たれるので、そちらで判定する。
 *
 * サーバ側(サービス層・ミドルウェア)では instanceof で判定してよいが、
 * **境界をまたいだ判定はこの関数だけを使う**。経路ごとに判定を書くと、
 * instanceof で書いた側が黙って常に false になる(#255)。
 */
export function httpErrorStatus(error: unknown): number | undefined {
	if (error instanceof HttpError) return error.status;
	if (typeof error !== "object" || error === null) return undefined;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

/** 認証切れ・未ログイン(401)か。クライアント・サーバのどちらからでも使える */
export function isUnauthorizedError(error: unknown): boolean {
	if (httpErrorStatus(error) === 401) return true;
	// status が落ちた場合の保険。seroval は Error の name を保つ
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "UnauthorizedError"
	);
}
