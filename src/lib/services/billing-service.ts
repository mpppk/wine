import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import { couponRedemption } from "#/db/schema";
import {
	extensionIdempotencyKey,
	normalizeCode,
	parseCampaignCodes,
	resolveExtensionDays,
} from "#/lib/billing/campaign-codes";
import { ENTITLED_STATUSES, resolvePlan } from "#/lib/billing/entitlements";
import { stripeClient } from "#/lib/billing/stripe-client";
import {
	issueStripeWrite,
	isUnconfirmedStripeWrite,
} from "#/lib/billing/stripe-write";
import { BadRequestError, ConflictError } from "#/lib/errors";
import { logError } from "#/lib/logger";
import { alertOperator } from "#/lib/observability/operator-alert";

// 会員区分のユーザ状態を扱うサービス層。判定ロジックは
// #/lib/billing/entitlements の純関数に置き、ここはD1アクセスとの薄い橋渡しに徹する。

/**
 * 複数ユーザのプレミアム判定を1クエリで行い、プレミアムなユーザIDの集合を返す。
 *
 * isPremiumUser をループで呼ぶと1人あたり1クエリになり、Workers の
 * サブリクエスト上限(1リクエスト1,000。D1呼び出しも計上される)に当たる(#253)。
 * 判定そのものは同じ resolvePlan を使うので、単体版と結果は一致する。
 */
export async function listPremiumUserIds(
	userIds: string[],
): Promise<Set<string>> {
	if (userIds.length === 0) return new Set();
	const rows = await db
		.select({
			referenceId: subscription.referenceId,
			status: subscription.status,
			periodEnd: subscription.periodEnd,
		})
		.from(subscription)
		.where(
			and(
				inArray(subscription.referenceId, userIds),
				inArray(subscription.status, [...ENTITLED_STATUSES]),
			),
		);
	const byUser = new Map<
		string,
		{ status: string | null; periodEnd: Date | null }[]
	>();
	for (const row of rows) {
		const list = byUser.get(row.referenceId) ?? [];
		list.push({ status: row.status, periodEnd: row.periodEnd });
		byUser.set(row.referenceId, list);
	}
	const premium = new Set<string>();
	for (const [userId, subs] of byUser) {
		if (resolvePlan(subs) === "premium") premium.add(userId);
	}
	return premium;
}

/** ユーザーが現在プレミアム会員(有効なサブスクリプション保持)か判定する。 */
export async function isPremiumUser(userId: string): Promise<boolean> {
	const rows = await db
		.select({
			status: subscription.status,
			periodEnd: subscription.periodEnd,
		})
		.from(subscription)
		.where(
			and(
				// referenceId は @better-auth/stripe が userId を格納する
				eq(subscription.referenceId, userId),
				inArray(subscription.status, [...ENTITLED_STATUSES]),
			),
		);
	return resolvePlan(rows) === "premium";
}

export interface RedeemExtensionResult {
	/** このコードで延長した日数。 */
	extendedDays: number;
	/** 延長後の次回請求日(ミリ秒)。webhook 反映前でもUIで表示できるよう返す。 */
	newPeriodEnd: number;
}

/**
 * 有効なプレミアム会員(active/trialing の Stripe サブスク保持者)の Stripe trial_end を
 * days 分だけ後ろ倒しして無償延長する(proration_behavior: none)。プレミアムでなければ throw。
 * DBの periodEnd は webhook で同期される。coupon_redemption 等の記録は呼び出し側の責務。
 * キャンペーンコード引換(redeemExtensionCode)と #114 の管理者による直接延長で共有する。
 */
export async function extendPremiumTrial(
	userId: string,
	days: number,
	options: { idempotencyKey?: string } = {},
): Promise<{ newPeriodEnd: number; stripeSubscriptionId: string }> {
	// 有効なサブスク(active/trialing)と Stripe subscription id を取得する。
	const rows = await db
		.select({
			status: subscription.status,
			periodEnd: subscription.periodEnd,
			stripeSubscriptionId: subscription.stripeSubscriptionId,
		})
		.from(subscription)
		.where(
			and(
				eq(subscription.referenceId, userId),
				inArray(subscription.status, [...ENTITLED_STATUSES]),
			),
		);
	const activeRow = rows.find((r) => r.stripeSubscriptionId);
	if (resolvePlan(rows) !== "premium" || !activeRow?.stripeSubscriptionId) {
		// 有効なサブスクが無い状態との衝突(コード引換・管理者延長で共有)。
		throw new ConflictError("プレミアム会員のみご利用いただけます。");
	}
	const stripeSubscriptionId = activeRow.stripeSubscriptionId;

	// 現在の期間終了を基準に延長する。Stripe(basil API)では current_period_end は
	// Subscription 本体ではなく Subscription Item 側にあるため items から読む。
	const stripeSub =
		await stripeClient.subscriptions.retrieve(stripeSubscriptionId);
	const currentPeriodEnd = stripeSub.items.data[0]?.current_period_end;
	if (!currentPeriodEnd) {
		throw new Error("現在の契約期間を取得できませんでした。");
	}
	// trial_end は Unix 秒。既存の期間終了に日数を足して後ろ倒しする。
	const newTrialEnd = currentPeriodEnd + days * 24 * 60 * 60;
	// 書き込みは issueStripeWrite で包む。ここから先の失敗だけが「適用されたか不明」に
	// なりうる(これより前の失敗は Stripe に何も送っていないので巻き戻して安全)。
	// 包む範囲を1呼び出しに限るのが重要で、広げると印の意味が失われる(#248)。
	await issueStripeWrite(() =>
		stripeClient.subscriptions.update(
			stripeSubscriptionId,
			{ trial_end: newTrialEnd, proration_behavior: "none" },
			options.idempotencyKey
				? { idempotencyKey: options.idempotencyKey }
				: undefined,
		),
	);

	return { newPeriodEnd: newTrialEnd * 1000, stripeSubscriptionId };
}

/**
 * キャンペーンコードで既存プレミアム会員の期間を延長する。
 * Stripe プロモコードは Checkout 専用で既存サブスクには使えないため、アプリ側でコードを
 * 検証し、Stripe サブスクの trial_end を延長する(extendPremiumTrial)。
 */
export async function redeemExtensionCode(
	userId: string,
	rawCode: string,
): Promise<RedeemExtensionResult> {
	const days = resolveExtensionDays(
		rawCode,
		parseCampaignCodes(env.CAMPAIGN_EXTENSION_CODES),
	);
	if (days === null) {
		throw new BadRequestError("コードが正しくありません。");
	}
	const code = normalizeCode(rawCode);

	// 引換を「先に」記録して1回性を原子的に確定する(unique 制約
	// coupon_redemption_user_code_uq)。並行リクエストやリトライは、後続の1本が
	// ここで即 unique 違反となり「利用済み」で弾かれるため、Stripe 延長は最大1回に限定
	// される(check-then-act で両方が Stripe 延長を実行する事故を防ぐ・#145)。
	try {
		await db.insert(couponRedemption).values({
			id: crypto.randomUUID(),
			userId,
			code,
			extendedDays: days,
		});
	} catch (_e) {
		throw new ConflictError("このコードは既に利用済みです。");
	}

	// 記録確定後に Stripe を延長する。延長に失敗したら、記録した引換行を打ち消して
	// (補償)整合を保つ。リトライ時に再度引換できるようにするためでもある。
	//
	// ただし**巻き戻してよいのは「Stripe が適用していない」と確信できるときだけ**(#248)。
	// 応答が失われただけで延長は適用済み、というケースで引換行を消すと、ユーザは同じ
	// コードをもう一度使えてしまい二重に延長される(7日コードで計14日)。冪等キーを
	// 付けるのはその再送を Stripe 側でも止めるため。
	try {
		const { newPeriodEnd } = await extendPremiumTrial(userId, days, {
			idempotencyKey: extensionIdempotencyKey(userId, code),
		});
		return { extendedDays: days, newPeriodEnd };
	} catch (e) {
		if (isUnconfirmedStripeWrite(e)) {
			// 適用されたか分からない。引換行を残して再引換を封じる(残高ではなく契約期間
			// なので、二重適用は後から検知も取り消しもできない)。行が残ること自体が
			// 「このコードは決着待ち」の記録になり、問い合わせ時の裏取りに使える。
			// ユーザの延長が宙に浮いたまま人手の決着待ちになる。放置すると
			// 「課金したのに反映されない」が問い合わせまで表に出ない(#395)。
			alertOperator(
				"extension code kept; stripe extension outcome unconfirmed",
				{ userId, code, days, err: e },
				{ tags: { kind: "billing_extension_unconfirmed" } },
			);
			throw new ConflictError(
				"延長処理の結果を確認できませんでした。延長が適用されている可能性があるため、しばらく待ってから契約状況をご確認ください。反映されない場合はお問い合わせください。",
			);
		}
		try {
			await db
				.delete(couponRedemption)
				.where(
					and(
						eq(couponRedemption.userId, userId),
						eq(couponRedemption.code, code),
					),
				);
		} catch (compensationErr) {
			// 補償の失敗で元例外を握り潰さない(#158 と同じイディオム)。ここを素通りさせると
			// 「延長されていないのに引換行だけ残り、ユーザは以後ずっと利用済みで弾かれる」
			// 状態の理由がどこにも残らない。両方の例外を1行に残して元例外を投げ直す。
			// 延長されていないのに引換行だけ残る = ユーザは以後ずっと「利用済み」で
			// 弾かれる。手で行を消すまで直らないので通知する(#395)。
			alertOperator(
				"extension code compensation failed; redemption row left",
				{ userId, code, err: compensationErr, originalErr: e },
				{ tags: { kind: "billing_extension_compensation_failed" } },
			);
			throw e;
		}
		logError("extension code redemption rolled back after stripe failure", {
			userId,
			code,
			err: e,
		});
		throw e;
	}
}
