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
