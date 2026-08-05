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

/**
 * 認証切れ・未ログインのメッセージ。
 *
 * server function の例外はクライアントへ渡る途中で素の `Error` に平坦化され、
 * クラス名(`UnauthorizedError`)も HTTP ステータスも失われる。クライアント側で
 * 「セッション失効」を見分けられる手掛かりはこのメッセージだけなので、
 * 送出側と判定側(`#/lib/quiz/save-status.ts`)が同じ定数を参照する(#255)。
 */
export const UNAUTHORIZED_MESSAGE = "Unauthorized";

/**
 * 想定外の失敗(=`HttpError` 以外)としてクライアントに見せる唯一の文言(#424)。
 *
 * server function の例外はクライアントへ渡る途中で素の `Error` に平坦化されるが
 * **`message` だけは保持される**。各画面はそれを `err.message` のまま描画するので、
 * 素通しすると失敗SQL・バインドパラメータ・内部ID・各SDK(D1/R2/Stripe/Workers AI)の
 * 例外文がそのまま利用者の画面に出る。露出の関門は `runWithHttpStatus` の1箇所に寄せ、
 * そこでこの文言へ差し替える(原因は同じ場所の `logError` に残る)。
 */
export const INTERNAL_ERROR_MESSAGE =
	"処理に失敗しました。時間をおいてもう一度お試しください。";

/** 認証切れ・未ログイン(401)。 */
export class UnauthorizedError extends HttpError {
	constructor(message = UNAUTHORIZED_MESSAGE) {
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

/** レートリミット超過(429)。文言はそのままUIに出るので日本語で持つ。 */
export const TOO_MANY_REQUESTS_MESSAGE =
	"操作が多すぎます。しばらく待ってからもう一度お試しください。";

/** 短時間の操作が多すぎる(429)。 */
export class TooManyRequestsError extends HttpError {
	constructor(message = TOO_MANY_REQUESTS_MESSAGE) {
		super(429, message);
		this.name = "TooManyRequestsError";
	}
}
