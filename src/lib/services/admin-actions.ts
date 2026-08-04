import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { oauthAccessToken, oauthConsent } from "#/db/auth-schema";
import {
	type AdminAuditDetail,
	adminAuditLog,
	couponRedemption,
	creditBalance,
	creditLedger,
} from "#/db/schema";
import type { AdminAuditAction } from "#/lib/admin/audit";
import { auth } from "#/lib/auth";
import { currentMonthKey } from "#/lib/credit/month";
import { BadRequestError } from "#/lib/errors";
import { logError, logInfo } from "#/lib/logger";
import * as billingService from "#/lib/services/billing-service";
import {
	type BatchUnit,
	ensureCurrentMonthGranted,
	ensureCurrentMonthGrantedMany,
	runInChunkedBatches,
} from "#/lib/services/credit-service";

// 管理画面の「書き込み(副作用あり)」操作のサービス層。閲覧専用の admin-service とは
// 分離し、各操作は admin_audit_log に証跡を残す。業務判定(自己BANの拒否など)も
// ここに置き、server fn(#/server/admin.ts)は認可 + zod 検証 + 委譲に徹する
// (docs/architecture.md)。

const DAY_SECONDS = 24 * 60 * 60;

/**
 * 「外部副作用(better-auth / Stripe / 別トランザクションのD1書き込み)を適用してから
 * 監査ログを書く」操作の共通後処理(#251)。
 *
 * クレジット付与のように操作と監査を同一 db.batch へ載せられる場合と違い、better-auth や
 * Stripe の副作用は D1 のバッチに同居できない。後段の記録が落ちると「操作は適用済み・
 * 証跡ゼロ」が成立し、adminMiddleware の `server fn failed` ログには操作者IDしか乗らない
 * ため、対象ユーザも操作内容も復元できなくなる。
 *
 * そこで記録の原子化ではなく**欠落を必ず検知できる形**にする:
 *  1. 副作用の成功直後に logInfo を出す(記録が落ちても「誰が誰に何をしたか」は残る)
 *  2. 記録の失敗は同じフィールド付きで logError してから rethrow する(監査欠落の明示)
 *
 * 副作用を伴う管理操作はすべてこの1関数を通す。経路ごとにログを書くと後から足した操作で
 * 必ず漏れるため(CLAUDE.md「横断的な防御・規約は共通チョークポイントに寄せる」)。
 */
async function recordAfterEffect(params: {
	actorUserId: string;
	targetUserId: string | null;
	action: AdminAuditAction;
	reason: string;
	detail?: AdminAuditDetail | null;
	/**
	 * 監査記録の書き込み。既定は admin_audit_log の1行 INSERT。
	 * 他の行も同じ batch で書く操作(プレミアム延長の coupon_redemption)は差し替える。
	 */
	write?: () => Promise<unknown>;
}): Promise<void> {
	const { actorUserId, targetUserId, action, reason, detail } = params;
	const fields = { actorUserId, targetUserId, action, reason, detail };
	// 副作用はこの時点で適用済み。記録の成否に関わらず痕跡を残す。
	logInfo("admin action applied", fields);
	try {
		if (params.write) {
			await params.write();
		} else {
			await recordAudit({ actorUserId, targetUserId, action, reason, detail });
		}
	} catch (e) {
		// 適用済みなのに監査ログが無い状態。ログが唯一の証跡になるので内容ごと残す。
		logError("admin audit record failed; action already applied", {
			...fields,
			err: e,
		});
		throw e;
	}
}

export interface GrantCreditsResult {
	/** 付与後の残高。 */
	balanceAfter: number;
	/** 残高が属する付与月 "YYYY-MM"(JST)。 */
	periodMonth: string;
	/** 今回付与しようとしたクレジット数。 */
	grantedAmount: number;
	/** 同一 requestId で既に付与済み(冪等再送)なら true。残高は加算されない。 */
	alreadyApplied: boolean;
}

async function readBalance(
	userId: string,
): Promise<{ balance: number; periodMonth: string }> {
	const rows = await db
		.select({
			balance: creditBalance.balance,
			periodMonth: creditBalance.periodMonth,
		})
		.from(creditBalance)
		.where(eq(creditBalance.userId, userId))
		.limit(1);
	return rows[0] ?? { balance: 0, periodMonth: currentMonthKey() };
}

/**
 * 管理者がユーザへクレジットを手動付与する(#113 障害補填・お詫び)。
 *
 * 案A(当月末まで有効): 当月残高に加算し、翌月の月次付与で補填分はリセット(失効)される。
 * そのため付与前に ensureCurrentMonthGranted で当月の残高行を確定させ、加算基準を当月に揃える。
 *
 * 冪等性は credit_ledger.request_id の unique 制約で担保する。残高加算・台帳追記・監査ログを
 * 単一の db.batch で原子的に書き、残高加算は「まだ台帳に requestId が無い時だけ」に条件付け
 * (台帳 INSERT より前に評価)することで、万一の再実行でも二重加算しない。
 */
export async function grantCredits(params: {
	actorUserId: string;
	targetUserId: string;
	amount: number;
	reason: string;
	/** 冪等キー。未指定ならサーバで生成する。 */
	requestId?: string;
}): Promise<GrantCreditsResult> {
	const { actorUserId, targetUserId, amount, reason } = params;
	const requestId = params.requestId ?? `admin_grant:${crypto.randomUUID()}`;

	// 当月の残高行を確定(案A: 加算の基準を当月付与額に揃える)。
	await ensureCurrentMonthGranted(targetUserId);
	const month = currentMonthKey();

	// 既に同一 requestId で付与済みなら、加算・監査追記をせず現在残高を返す(冪等)。
	const existing = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(eq(creditLedger.requestId, requestId))
		.limit(1);
	if (existing[0]) {
		const bal = await readBalance(targetUserId);
		return {
			balanceAfter: bal.balance,
			periodMonth: bal.periodMonth,
			grantedAmount: amount,
			alreadyApplied: true,
		};
	}

	await db.batch([
		// 残高加算。まだ台帳に requestId が無い時だけ加算する(台帳 INSERT より前に評価される
		// ため、再実行時は既存行を見て加算をスキップし二重加算を防ぐ)。
		db
			.update(creditBalance)
			.set({
				balance: sql`${creditBalance.balance} + ${amount}`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(creditBalance.userId, targetUserId),
					sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${requestId})`,
					// 月境界: 上の ensureCurrentMonthGranted とこのコミットの間に、別リクエストの
					// 月次リセットが割り込むことがある。ガードが無いと**翌月のリセット済み残高**に
					// 当月ぶんの補填が乗り、案A(当月末まで有効)の下で1ヶ月余分に生存する。
					// 月が替わっていたら台帳のみ記録に倒れる(#403、settle/refund の #147 と同型)。
					eq(creditBalance.periodMonth, month),
				),
			),
		// 台帳追記。type="admin_grant" で月次付与と区別する。unique(request_id) が再送を弾く。
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId: targetUserId,
				amount,
				type: "admin_grant",
				requestId,
				periodMonth: month,
				tokenAmount: null,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
		// 監査ログ。
		db.insert(adminAuditLog).values({
			id: crypto.randomUUID(),
			actorUserId,
			targetUserId,
			action: "credit_grant",
			detail: { amount, requestId, periodMonth: month },
			reason,
		}),
	]);

	const bal = await readBalance(targetUserId);
	return {
		balanceAfter: bal.balance,
		periodMonth: bal.periodMonth,
		grantedAmount: amount,
		alreadyApplied: false,
	};
}

export interface ExtendPremiumResult {
	extendedDays: number;
	/** 延長後の次回請求日(ミリ秒)。webhook 反映前でも表示できるよう返す。 */
	newPeriodEnd: number;
}

/**
 * 管理者がプレミアム会員の期間を直接延長する(#114 お詫び, 案b)。
 * Stripe trial_end 延長ロジック(billingService.extendPremiumTrial)を流用し、コード入力を
 * 挟まず即時反映する。期間延長は**プレミアム会員のみ**有効(無料ユーザへのお詫びは #113 の
 * クレジット補填が受け皿)。適用履歴を coupon_redemption と admin_audit_log の両方に記録する。
 *
 * 注: 「N日延長」は自然な冪等キーを持たない(再送すると二重に延長される)ため、UI 側の確認
 * ダイアログと送信中ボタン無効化で二重送信を防ぐ(クレジット付与と異なり冪等ではない)。
 */
export async function extendPremium(params: {
	actorUserId: string;
	targetUserId: string;
	days: number;
	reason: string;
}): Promise<ExtendPremiumResult> {
	const { actorUserId, targetUserId, days, reason } = params;

	// Stripe 側を先に延長する(プレミアムでなければ throw)。DBの periodEnd は webhook で同期。
	const { newPeriodEnd, stripeSubscriptionId } =
		await billingService.extendPremiumTrial(targetUserId, days);

	// 適用履歴を coupon_redemption(管理者発行の合成コード)と監査ログに記録する。
	// コードは unique(userId, code) を満たすよう毎回一意にする(接頭辞 "admin:" で判別)。
	// Stripe は延長済みで補償もできないため、記録が落ちた場合は logError で欠落を残す(#251)。
	const code = `admin:${crypto.randomUUID()}`;
	await recordAfterEffect({
		actorUserId,
		targetUserId,
		action: "premium_extension",
		reason,
		detail: { days, newPeriodEnd, stripeSubscriptionId, code },
		write: () =>
			db.batch([
				db.insert(couponRedemption).values({
					id: crypto.randomUUID(),
					userId: targetUserId,
					code,
					extendedDays: days,
				}),
				db.insert(adminAuditLog).values({
					id: crypto.randomUUID(),
					actorUserId,
					targetUserId,
					action: "premium_extension",
					detail: { days, newPeriodEnd, stripeSubscriptionId, code },
					reason,
				}),
			]),
	});

	return { extendedDays: days, newPeriodEnd };
}

// ── #115: セッション/MCP失効・BAN ──────────────────────────────────────────────
// better-auth admin プラグインのサーバAPIは、呼び出し元(管理者)のリクエストヘッダを
// 渡してプラグイン側の admin 認可を通す必要があるため、headers を引数で受け取る。

/** 対象ユーザの全セッションを強制ログアウトする(#115)。 */
export async function revokeSessions(params: {
	actorUserId: string;
	targetUserId: string;
	reason: string;
	/** 操作した管理者のリクエストヘッダ(better-auth の admin 認可に必要)。 */
	headers: Headers;
}): Promise<{ ok: true }> {
	const { actorUserId, targetUserId, reason, headers } = params;
	await auth.api.revokeUserSessions({
		body: { userId: targetUserId },
		headers,
	});
	await recordAfterEffect({
		actorUserId,
		targetUserId,
		action: "revoke_sessions",
		reason,
	});
	return { ok: true };
}

/**
 * ユーザを BAN(利用停止)する(#115)。expiresInDays 未指定は無期限。
 * 自分自身の BAN は管理画面からのロックアウトになるため、副作用の前に拒否する。
 */
export async function banUser(params: {
	actorUserId: string;
	targetUserId: string;
	reason: string;
	expiresInDays?: number;
	headers: Headers;
}): Promise<{ ok: true }> {
	const { actorUserId, targetUserId, reason, expiresInDays, headers } = params;
	if (targetUserId === actorUserId) {
		throw new BadRequestError("自分自身を利用停止することはできません。");
	}
	await auth.api.banUser({
		body: {
			userId: targetUserId,
			banReason: reason,
			banExpiresIn: expiresInDays ? expiresInDays * DAY_SECONDS : undefined,
		},
		headers,
	});
	// better-auth の banUser は Web セッションしか削除せず、MCP(OAuth)トークンには
	// 触れない。BAN の目的は濫用の停止なので、書き込みと AI クレジット消費が続く
	// 3系統目の入口をここで塞ぐ(#330)。行削除で refresh token も同時に失効し、
	// BAN 中はサインイン不可なので再認可もできない。
	//
	// 失効に失敗しても BAN 自体は適用済みで、`/api/mcp` の入口ガードが停止中の
	// アクセスを拒否する。ここで throw すると「BAN 適用済み・監査ログ無し」を
	// 作ってしまうため、証跡を残して記録まで進める(失効できなかったことは
	// mcpRevoked=false として監査ログにも残す)。
	let revoked: { tokensDeleted: number; consentsDeleted: number } | null = null;
	try {
		revoked = await revokeMcpConnections(targetUserId);
	} catch (e) {
		logError("ban applied but revoking mcp connections failed", {
			actorUserId,
			targetUserId,
			err: e,
		});
	}
	await recordAfterEffect({
		actorUserId,
		targetUserId,
		action: "ban",
		reason,
		detail: {
			banExpiresInDays: expiresInDays ?? null,
			mcpRevoked: revoked !== null,
			mcpTokensDeleted: revoked?.tokensDeleted ?? null,
			mcpConsentsDeleted: revoked?.consentsDeleted ?? null,
		},
	});
	return { ok: true };
}

/** ユーザの BAN を解除する(#115)。 */
export async function unbanUser(params: {
	actorUserId: string;
	targetUserId: string;
	reason: string;
	headers: Headers;
}): Promise<{ ok: true }> {
	const { actorUserId, targetUserId, reason, headers } = params;
	await auth.api.unbanUser({ body: { userId: targetUserId }, headers });
	await recordAfterEffect({
		actorUserId,
		targetUserId,
		action: "unban",
		reason,
	});
	return { ok: true };
}

/** ユーザの MCP(OAuth)連携をすべて失効し、削除件数を監査ログに残す(#115)。 */
export async function revokeMcp(params: {
	actorUserId: string;
	targetUserId: string;
	reason: string;
}): Promise<{ tokensDeleted: number; consentsDeleted: number }> {
	const { actorUserId, targetUserId, reason } = params;
	const res = await revokeMcpConnections(targetUserId);
	await recordAfterEffect({
		actorUserId,
		targetUserId,
		action: "revoke_mcp",
		reason,
		detail: res,
	});
	return res;
}

// ── #116: なりすまし(impersonation) ──────────────────────────────────────────

/**
 * 対象ユーザへのなりすましを開始する(#116)。成功すると better-auth が
 * 「対象ユーザのセッションCookie」＋「元の管理者セッションを退避した admin_session
 * Cookie」を発行し、`tanstackStartCookies` がそれをレスポンスへ転送する。
 *
 * 管理者を対象にしたなりすましは better-auth 側が拒否する(`allowImpersonatingAdmins`
 * を有効にしていないため)。自分自身の指定だけは 403 ではなく意味の分かる 400 にしたい
 * ので、副作用の前にここで弾く(banUser と同じ方針)。
 *
 * なりすまし中は書き込みが一切通らない(`src/server/middleware.ts` /
 * `requireApiSession` の共通ガード)。この関数はセッション発行と証跡だけを担う。
 */
export async function startImpersonation(params: {
	actorUserId: string;
	targetUserId: string;
	reason: string;
	/** 操作した管理者のリクエストヘッダ(better-auth の admin 認可に必要)。 */
	headers: Headers;
}): Promise<{ ok: true }> {
	const { actorUserId, targetUserId, reason, headers } = params;
	if (targetUserId === actorUserId) {
		throw new BadRequestError("自分自身になりすますことはできません。");
	}
	await auth.api.impersonateUser({ body: { userId: targetUserId }, headers });
	await recordAfterEffect({
		actorUserId,
		targetUserId,
		action: "impersonate_start",
		reason,
	});
	return { ok: true };
}

/**
 * なりすましを終了し、退避してあった管理者セッションへ戻す(#116)。
 *
 * 呼び出し元は「なりすまし中のセッション」なので、監査ログの操作者(actor)は
 * `session.impersonatedBy` に入っている元の管理者になる。理由の入力を求める相手が
 * (画面上は)なりすまされている側になってしまうため、開始時と違って理由は固定文言。
 * 開始時の理由が同じ対象ユーザの証跡として残っており、対応関係は追える。
 */
export async function stopImpersonation(params: {
	/** なりすましを開始した管理者の user.id(`session.impersonatedBy`)。 */
	actorUserId: string;
	/** なりすまされていたユーザの user.id。 */
	targetUserId: string;
	/** なりすまし中セッションのリクエストヘッダ(admin_session Cookie の復元に必要)。 */
	headers: Headers;
}): Promise<{ ok: true }> {
	const { actorUserId, targetUserId, headers } = params;
	await auth.api.stopImpersonating({ headers });
	await recordAfterEffect({
		actorUserId,
		targetUserId,
		action: "impersonate_stop",
		reason: "なりすましを終了した",
	});
	return { ok: true };
}

/**
 * 管理操作の証跡を admin_audit_log に1行記録する。破壊的操作の共通後処理。
 * targetUserId は特定ユーザに紐づかない操作(一括付与など)では null を渡す。
 */
export async function recordAudit(params: {
	actorUserId: string;
	targetUserId: string | null;
	action: AdminAuditAction;
	reason: string;
	detail?: AdminAuditDetail | null;
}): Promise<void> {
	await db.insert(adminAuditLog).values({
		id: crypto.randomUUID(),
		actorUserId: params.actorUserId,
		targetUserId: params.targetUserId,
		action: params.action,
		detail: params.detail ?? null,
		reason: params.reason,
	});
}

/**
 * ユーザの MCP(OAuth)連携をすべて失効する(#115)。アカウント乗っ取り疑い・連携アプリ側の
 * 事故に対応する。oauth_access_token / oauth_consent の該当ユーザ行を削除する。
 * better-auth の mcp プラグインには失効APIが無いため直接削除する。
 */
export async function revokeMcpConnections(
	userId: string,
): Promise<{ tokensDeleted: number; consentsDeleted: number }> {
	const [tokens, consents] = await db.batch([
		db
			.delete(oauthAccessToken)
			.where(eq(oauthAccessToken.userId, userId))
			.returning({ id: oauthAccessToken.id }),
		db
			.delete(oauthConsent)
			.where(eq(oauthConsent.userId, userId))
			.returning({ id: oauthConsent.id }),
	]);
	return { tokensDeleted: tokens.length, consentsDeleted: consents.length };
}

export interface BulkGrantResult {
	/** 対象ユーザ数。 */
	affected: number;
	/** 新規に付与したユーザ数。 */
	granted: number;
	/** 既に同一インシデントで付与済み(冪等スキップ)だったユーザ数。 */
	alreadyApplied: number;
	/** 今回新規付与した合計クレジット(granted × amount)。 */
	totalGranted: number;
}

/**
 * 障害補填などで複数ユーザへ一括でクレジットを付与する(#116)。各ユーザへの付与は #113 の
 * grantCredits を流用し、requestId=`admin_grant:{incidentId}:{userId}` で冪等化する
 * (同一インシデントの再実行では二重付与しない)。各ユーザに credit_grant の監査ログが残り、
 * さらに一括操作全体の要約を bulk_credit_grant(targetUserId=null)として1行記録する。
 */
export async function bulkGrantCredits(params: {
	actorUserId: string;
	incidentId: string;
	userIds: string[];
	amount: number;
	reason: string;
}): Promise<BulkGrantResult> {
	const { actorUserId, incidentId, amount, reason } = params;
	const userIds = [...new Set(params.userIds)];
	const requestIdOf = (userId: string) => `admin_grant:${incidentId}:${userId}`;

	// 当月の残高行を全員ぶん確定させる(単体の grantCredits と同じ「案A: 加算の基準を
	// 当月付与額に揃える」前提)。セットベース版を使うのは、単体版のループだと
	// 1ユーザ3〜4クエリで 200人分が Workers のサブリクエスト上限を超えるため(#253)。
	await ensureCurrentMonthGrantedMany(userIds);
	const month = currentMonthKey();

	// 既に同一 requestId で付与済みのユーザを1クエリで洗い出す(冪等再送の判定)。
	// 実際の二重加算防止は下の NOT EXISTS ガードが担うので、ここは件数の内訳を
	// 返すためだけに使う。
	const requestIds = userIds.map(requestIdOf);
	const appliedRows =
		requestIds.length > 0
			? await db
					.select({ requestId: creditLedger.requestId })
					.from(creditLedger)
					.where(inArray(creditLedger.requestId, requestIds))
			: [];
	const applied = new Set(
		appliedRows.map((r) => r.requestId).filter((id): id is string => !!id),
	);

	const pending = userIds.filter((id) => !applied.has(requestIdOf(id)));
	const alreadyApplied = userIds.length - pending.length;
	const granted = pending.length;

	// 付与本体。1ユーザぶんの「条件付き残高加算 + 台帳追記 + 監査ログ」を単体版と同じ形で
	// 積み、db.batch(=1サブリクエスト)へ畳む。残高加算に NOT EXISTS(request_id) を
	// 付ける形も単体版と同一。
	//
	// **1ユーザぶんを1ユニットとして渡す**のが要点(#334)。フラットな配列を固定長で
	// 切ると、境界のユーザだけ残高加算と台帳追記が別トランザクションに割れる。後段が
	// 失敗すると「残高だけ増えて台帳行が無い」状態になり、同一 incidentId での冪等
	// リトライが(台帳行を見る)既付与判定と NOT EXISTS ガードの両方をすり抜けて
	// **二重加算**する。
	const units: BatchUnit[] = [];
	for (const targetUserId of pending) {
		const requestId = requestIdOf(targetUserId);
		units.push([
			db
				.update(creditBalance)
				.set({
					balance: sql`${creditBalance.balance} + ${amount}`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(creditBalance.userId, targetUserId),
						sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${requestId})`,
						// 月境界: 単体版と同じ理由(#403)。
						eq(creditBalance.periodMonth, month),
					),
				),
			db
				.insert(creditLedger)
				.values({
					id: crypto.randomUUID(),
					userId: targetUserId,
					amount,
					type: "admin_grant",
					requestId,
					periodMonth: month,
					tokenAmount: null,
				})
				.onConflictDoNothing({ target: creditLedger.requestId }),
			// 監査ログ。単体付与と同じ action で、一括かどうかは incidentId で判別する
			db.insert(adminAuditLog).values({
				id: crypto.randomUUID(),
				actorUserId,
				targetUserId,
				action: "credit_grant",
				detail: { amount, requestId, periodMonth: month, incidentId },
				reason,
			}),
		]);
	}
	await runInChunkedBatches(units);

	await recordAudit({
		actorUserId,
		targetUserId: null,
		action: "bulk_credit_grant",
		reason,
		detail: {
			incidentId,
			affected: userIds.length,
			granted,
			alreadyApplied,
			amount,
		},
	});
	return {
		affected: userIds.length,
		granted,
		alreadyApplied,
		totalGranted: granted * amount,
	};
}
