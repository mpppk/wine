// キャンペーンコード引換で Stripe を延長するときの「失敗の扱い方」を決める純ロジック。
// DBアクセス・Stripe クライアントを持たないので単体テスト(jsdom)で検証できる。
//
// 引換は「引換行を先に INSERT → Stripe を延長」の順で行う(#145)。Stripe が失敗したときに
// 引換行を消して再引換を許してよいかは、**その失敗で Stripe 側の変更が適用されていないと
// 言い切れるか**で決まる。適用済みかもしれない状態で行を消すと、再送で二重延長になる(#248)。

/** Stripe の変更要求が失敗し、適用されたかどうか判定できないことを表す。 */
export class StripeChangeUncertainError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "StripeChangeUncertainError";
	}
}

/**
 * 適用の有無を確認できなかったときにユーザへ返す文言。
 * 「利用済みのまま保留する」ことまで伝えないと、コードが使えない理由が分からない。
 */
export const EXTENSION_OUTCOME_UNKNOWN_MESSAGE =
	"延長が適用されたか確認できませんでした。二重に延長されないよう、このコードは利用済みのまま保留しています。反映されない場合はお問い合わせください。";

/**
 * Stripe がリクエストを**受理せずに**返した種類のエラーか(=変更は適用されていない)。
 *
 * ホワイトリストで判定する。ネットワーク断・タイムアウト・Stripe 側の 5xx
 * (`api_error` / `StripeConnectionError` 等)は「適用済みだが応答だけ失われた」場合と
 * 区別が付かないため、未知の種別はすべて「不明」に倒す(安全側=引換行を残す側)。
 *
 * `idempotency_error` も**意図的に含めない**。同じ冪等キーで異なるパラメータを送ると出る
 * エラーで、これが出る時点で「1回目の延長は適用されている」ことを意味するため、
 * 引換行を消して再引換を許すのは最も避けたいケースになる。
 */
export function isStripeRequestRejected(err: unknown): boolean {
	const type = (err as { type?: unknown } | null | undefined)?.type;
	return (
		typeof type === "string" &&
		(REJECTED_STRIPE_ERROR_TYPES as readonly string[]).includes(type)
	);
}

const REJECTED_STRIPE_ERROR_TYPES = [
	// パラメータ不正・対象なし等。Stripe が検証で弾いており副作用は無い。
	"invalid_request_error",
	// APIキー不正。認証段階で弾かれる。
	"authentication_error",
	// 権限不足(Connect 等)。
	"permission_error",
	// レート制限。受理されずに 429 が返る。
	"rate_limit_error",
	// カード決済起因。trial_end 延長では出ないが、出たとしても変更は適用されない。
	"card_error",
] as const;

/**
 * Stripe の変更要求に付ける冪等キーを導出する。
 *
 * (userId, code) は引換行の unique 制約(coupon_redemption_user_code_uq)と同じ組で、
 * 「引換行を消して再引換した」場合でも同じキーになる。1回目が適用済みだった場合、
 * 2回目は Stripe 側が `idempotency_error` を返して**二重延長を防ぐ**。
 * (延長後は期間終了が動くので trial_end が変わり、応答の再生ではなくエラーになる。
 *  どちらでも「2回適用されない」という目的は満たす。)
 *
 * Stripe の冪等キーは 255 文字まで。code は入力検証で 64 文字以下、userId は
 * better-auth 生成の短いIDなので、この組み合わせが上限を超えることはない。
 */
export function extensionIdempotencyKey(userId: string, code: string): string {
	return `ext:${userId}:${code}`.slice(0, 255);
}
