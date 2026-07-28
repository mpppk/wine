// Stripe への「書き込み」が失敗したとき、それが **適用されずに拒否された** のか
// **適用されたかどうか分からない** のかを区別するための純ロジック(#248)。
//
// なぜ区別が要るか: 引換コードの適用は「先に引換行を記録 → Stripe を延長」の順で行い、
// Stripe が失敗したら引換行を消して再挑戦を許す(補償)。この補償は
// **Stripe が適用していないと確信できるときだけ**行ってよい。適用済みなのに引換行を
// 消すと、ユーザは同じコードをもう一度使えてしまい、二重に延長される(7日コードで14日)。
//
// 判断を誤ったときのコストが非対称であることが設計の根拠になっている:
//  - 消すべき行を残した   → ユーザはコードを1回損する(サポートで復旧できる)
//  - 残すべき行を消した   → 二重延長。売上の欠損で、後から検知する手立ても無い
// よって **分からない側("unknown")に倒す**。Stripe が明示的に拒否したと読める場合だけ
// "rejected" とする。

/**
 * Stripe への書き込みの結末。
 * - `rejected`: Stripe がリクエストを受け取った上で 4xx で拒否した。副作用は無い。
 * - `unknown` : 適用されたかどうか分からない(接続断・タイムアウト・5xx・冪等キー衝突)。
 */
export type StripeWriteOutcome = "rejected" | "unknown";

/**
 * 「Stripe への書き込みを実際に発行した後に失敗した」ことを型で運ぶエラー。
 *
 * 呼び出し前(残高チェック・サブスク検索・retrieve)の失敗と、書き込み自体の失敗は
 * 補償の可否が正反対になる。エラーの形だけから見分けようとすると、想定外の例外を
 * 「書き込み前の失敗」と誤読して補償してしまうため、発行地点で包んで印を付ける。
 *
 * `message` は元エラーのものをそのまま引き継ぐ(UI に出る文言を変えない)。
 */
export class StripeWriteFailure extends Error {
	readonly outcome: StripeWriteOutcome;
	constructor(cause: unknown, outcome: StripeWriteOutcome) {
		super(messageOf(cause));
		this.name = "StripeWriteFailure";
		this.outcome = outcome;
		this.cause = cause;
	}
}

/**
 * Stripe への書き込みを発行する。失敗は必ず {@link StripeWriteFailure} に包んで投げ直す。
 * 包む範囲は**書き込み1回だけ**にすること(前後の処理まで含めると印の意味が失われる)。
 */
export async function issueStripeWrite<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (e) {
		throw new StripeWriteFailure(e, classifyStripeWriteFailure(e));
	}
}

/**
 * 適用されたか分からない失敗か。補償(記録の巻き戻し)を行ってよいかの判定に使う。
 *
 * 書き込み前に落ちた場合(= `StripeWriteFailure` で包まれていない)は、そもそも
 * リクエストが発行されていないので `false`(= 巻き戻して安全)。
 */
export function isUnconfirmedStripeWrite(error: unknown): boolean {
	return error instanceof StripeWriteFailure && error.outcome === "unknown";
}

/**
 * Stripe SDK のエラーから結末を推定する。
 *
 * Stripe のエラーは `statusCode`(HTTPステータス)と `rawType`(`invalid_request_error` 等)を
 * 持つ。ステータスを持たないもの(`StripeConnectionError` = 接続断・タイムアウト)は
 * **応答が失われただけで適用されている可能性がある**ので `unknown`。5xx も同様に
 * Stripe 側で処理が始まっていたかどうか分からない。
 *
 * `idempotency_error` は 400 で返るが意味が逆で、「同じ冪等キーが別パラメータで再利用された」
 * = **先行するリクエストが既に受理されている**ことを示す。4xx の一括扱いに混ぜると
 * 「拒否された」と誤読して二重適用を招くため、明示的に除外する。
 */
export function classifyStripeWriteFailure(error: unknown): StripeWriteOutcome {
	if (typeof error !== "object" || error === null) return "unknown";
	const { statusCode, rawType, type } = error as {
		statusCode?: unknown;
		rawType?: unknown;
		type?: unknown;
	};
	if (rawType === "idempotency_error" || type === "StripeIdempotencyError") {
		return "unknown";
	}
	if (typeof statusCode !== "number") return "unknown";
	// 4xx = Stripe が受け取って検証し、副作用を起こさずに突き返した
	return statusCode >= 400 && statusCode < 500 ? "rejected" : "unknown";
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : "Stripe request failed";
}
