import { waitUntil } from "cloudflare:workers";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "#/db";
import { creditBalance, creditLedger } from "#/db/schema";
import type { CreditCharge } from "#/lib/billing/ai-pricing";
import { costToCredits, refundCredits } from "#/lib/credit/credit-math";
import {
	grantRequestId,
	grantUpgradeRequestId,
	monthlyGrantForPlan,
} from "#/lib/credit/grants";
import { currentMonthKey } from "#/lib/credit/month";
import {
	REFUND_SUFFIX,
	refundRequestId,
	SETTLE_SUFFIX,
	settleRequestId,
} from "#/lib/credit/reservation";
import type { CreditLedgerType } from "#/lib/credit/types";
import { logError, logInfo, logWarn } from "#/lib/logger";
import * as billingService from "#/lib/services/billing-service";

// AIクレジットの付与・消費のD1アクセス層。判定・換算の純ロジックは #/lib/credit/ に置き、
// ここは台帳(credit_ledger)と残高キャッシュ(credit_balance)への薄い橋渡しに徹する。
//
// 付与は暦月一律だが Cron は導入せず「遅延付与」する: 残高参照・消費の入口で必ず
// ensureCurrentMonthGranted を呼び、当月未付与なら付与する(冪等)。将来 Cron を足す場合は
// この関数を per-user でループ呼び出しすれば proactive 付与に拡張できる。
//
// 消費はトークン従量で、消費量が事前に確定しないため「予約(reserve)→ 実測確定(settle)」で
// 扱う: 先に最大見積を条件付きで引き(残高不足ならブロック)、実測との差分を返却する。
//
// 予約の後始末(確定/返却)はリクエストが打ち切られても完走させ、それでも取りこぼした分は
// 次回の予約時に回収する(#246)。詳細は keepAlive / reclaimOrphanReservations を参照。

/**
 * D1 への後始末をリクエストのライフサイクルから切り離して完走させる。
 *
 * Workers はクライアント切断・isolate 入替でリクエストコンテキストを打ち切ることがあり、
 * その時点で未完了の I/O は失敗する。確定(settle)・返却(refund)が落ちると予約したクレジットが
 * 宙に浮くため、書き込みの promise を waitUntil に登録して打ち切り後も完走させる(#246)。
 *
 * 呼び出し側は戻り値を await して従来どおり完了を待つ(waitUntil は待機の代わりではなく、
 * 「待たれなくなっても走り切らせる」ための保険)。リクエストコンテキストの外
 * (workers テスト・将来の Cron)では waitUntil が使えないため、その場合は素通しする。
 */
function keepAlive<T>(work: Promise<T>): Promise<T> {
	try {
		waitUntil(work);
	} catch {
		// リクエストコンテキスト外。呼び出し側の await だけで完了を待つ。
	}
	return work;
}

/**
 * 予約を孤児(=打ち切りで確定も返却もされなかった)とみなすまでの猶予。実行中のリクエストを
 * 誤って回収しないよう、AI 推論を含む1リクエストの現実的な上限より十分長く取る。
 */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
/** 1回の入口で回収する上限。1リクエストあたりのD1呼び出し数を抑える。 */
const ORPHAN_RECLAIM_LIMIT = 10;
/**
 * 孤児の走査範囲(現在時刻からの遡り幅)。返却が残高に反映されるのは予約と同じ付与月の間
 * だけなので、それを十分に含む長さがあれば足りる。索引レンジを絞って全期間走査を防ぐ。
 */
const ORPHAN_SCAN_WINDOW_MS = 40 * 24 * 60 * 60 * 1000;

/**
 * 1つの db.batch に載せる最大ステートメント数(目安)。
 *
 * db.batch は何本積んでも **1サブリクエスト**なので、上限内で大きく取るほど
 * サブリクエスト数は減る。一方で1回のリクエストボディが際限なく膨らむのは避けたいので、
 * 200ユーザ × 数ステートメントを数回に割る程度の値にしている(#253)。
 * 原子性の要るまとまり(ユニット)を分断しないため、実際のチャンクはこの値を
 * わずかに下回る位置で切れる。
 */
const BATCH_STATEMENT_CHUNK = 100;

type BatchStatements = Parameters<typeof db.batch>[0];
export type BatchStatement = BatchStatements[number];

/** 同一トランザクションで完結させたいステートメントのまとまり(例: 1ユーザぶんの付与)。 */
export type BatchUnit = readonly BatchStatement[];

/**
 * ステートメントを「ユニット」単位でチャンクに割り、db.batch で流す。
 *
 * **チャンク間には原子性が無い**。ここに載せてよいのは「1ユニットが同一チャンクに
 * 収まり、かつ requestId で冪等」な書き込みだけ。途中で落ちても、再実行が残りを
 * 埋めて最終状態が同じになる形を保つ。
 *
 * ユニットを跨いで切ると、その境界のユーザだけ「残高は加算・台帳は未記録」が成立し、
 * 再実行時の冪等ガード(`NOT EXISTS(request_id)`)が台帳行を見ないため**二重加算**に
 * なる(#334。フラットな配列を固定長でスライスしていた実装は、1ユニットが上限の
 * 約数でない限りこれを起こしうる)。そのため呼び出し側は原子性の要るまとまりを
 * ユニットとして渡し、この関数はユニット境界でだけ切る。
 *
 * 1ユニット単体が上限を超える場合はそのユニットだけで1バッチにする(サイズの目安より
 * 原子性を優先する)。
 */
export async function runInChunkedBatches(
	units: readonly BatchUnit[],
): Promise<void> {
	const flush = async (chunk: BatchStatement[]) => {
		const [first, ...rest] = chunk;
		if (!first) return;
		await db.batch([first, ...rest]);
	};
	let chunk: BatchStatement[] = [];
	for (const unit of units) {
		if (unit.length === 0) continue;
		if (
			chunk.length > 0 &&
			chunk.length + unit.length > BATCH_STATEMENT_CHUNK
		) {
			await flush(chunk);
			chunk = [];
		}
		chunk.push(...unit);
	}
	await flush(chunk);
}

export interface CreditBalance {
	balance: number;
	periodMonth: string;
}

export type ReserveResult =
	| {
			ok: true;
			requestId: string;
			/** 予約した(=残高から引いた)クレジット */
			reservedCredits: number;
			/** 予約時に見積ったコスト。実測が取れなかったときの確定値に使う。 */
			reservedMicroUsd: number;
			balanceAfter: number;
	  }
	| {
			ok: false;
			reason: "insufficient";
			balance: number;
			required: number;
	  };

/**
 * 当月分が未付与なら遅延付与し、さらに月途中のプラン昇格分を差分付与する(冪等)。
 * 残高参照・消費の入口で必ず呼ぶ。
 * - 当月未付与(新月/残高行なし): 現プランの付与額でリセット付与する。
 *   grant 台帳は requestId=grant:{userId}:{YYYY-MM} の unique で月1本に絞り、
 *   残高は新月のみ付与額へリセット(setWhere で当月への二重リセットを防ぎ、消費との
 *   競合で残高を巻き戻さない)。
 * - 当月付与済みでも、現プランの付与額が当月の累計付与額を上回る場合(=月途中の
 *   プレミアム昇格、または付与額そのものの引き上げ)は差分を追加付与する(#142)。
 *   requestId=grant_upgrade:{userId}:{YYYY-MM}:{target} の unique で
 *   「同じ付与目標額への引き上げは月1本」に絞る(#387。target を含めない固定キーは
 *   月1回しか差分付与を通さず、増額と昇格が同月に重なると後者が無言で消えた)。
 */
/**
 * ensureCurrentMonthGranted の複数ユーザ版。**単体版をループで呼ばないための存在**で、
 * 付与の意味論は単体版と同一に保つ(同じ requestId 規約・同じ setWhere ガード・同じ
 * grant/grant_upgrade の使い分け)。
 *
 * 単体版は1ユーザあたり残高SELECT・プラン判定SELECT・(必要なら)台帳SELECTと db.batch で
 * 3〜4回の D1 呼び出しになる。一括付与(#116)は最大200ユーザなので、そのままループすると
 * Workers のサブリクエスト上限(1リクエスト1,000)を超えて途中で落ちる(#253)。
 * ここでは読み取りを3本のセットベースクエリにまとめ、書き込みは1つの db.batch
 * (=1サブリクエスト)へ畳む。
 *
 * **意味論を単体版と一致させるのは呼び出し側ではなくテストの仕事**にしている
 * (credit-service.workers.test.ts が同じ入力に対する両者の結果を突き合わせる)。
 */
export async function ensureCurrentMonthGrantedMany(
	userIds: readonly string[],
): Promise<void> {
	const targets = [...new Set(userIds)];
	if (targets.length === 0) return;
	const month = currentMonthKey();

	// 1) 残高行の付与月(当月へリセット済みか)
	const balanceRows = await db
		.select({
			userId: creditBalance.userId,
			periodMonth: creditBalance.periodMonth,
		})
		.from(creditBalance)
		.where(inArray(creditBalance.userId, targets));
	const balanceMonth = new Map(
		balanceRows.map((r) => [r.userId, r.periodMonth]),
	);

	// 2) プラン判定(1クエリ)
	const premium = await billingService.listPremiumUserIds(targets);

	// 3) 当月の累計付与額(grant + grant_upgrade)。昇格の差分付与の判定に使う
	const grantedRows = await db
		.select({
			userId: creditLedger.userId,
			total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)`,
		})
		.from(creditLedger)
		.where(
			and(
				inArray(creditLedger.userId, targets),
				eq(creditLedger.periodMonth, month),
				inArray(creditLedger.type, ["grant", "grant_upgrade"]),
			),
		)
		.groupBy(creditLedger.userId);
	const grantedTotal = new Map(grantedRows.map((r) => [r.userId, r.total]));

	// 1ユーザぶんを1ユニットとして積む(残高更新と台帳追記が別バッチに割れると
	// 冪等リトライで二重加算になる。#334)
	const units: BatchUnit[] = [];
	for (const userId of targets) {
		const target = monthlyGrantForPlan(premium.has(userId));
		if (balanceMonth.get(userId) === month) {
			// 当月付与済み。月途中のプラン昇格ぶんだけ差分付与する(単体版の topUpMidMonthUpgrade)
			const diff = target - (grantedTotal.get(userId) ?? 0);
			if (diff <= 0) continue;
			const requestId = grantUpgradeRequestId(userId, month, target);
			units.push([
				db
					.update(creditBalance)
					.set({
						balance: sql`${creditBalance.balance} + ${diff}`,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(creditBalance.userId, userId),
							sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${requestId})`,
							// 月境界: 単体版と同じ理由(#403)。
							eq(creditBalance.periodMonth, month),
						),
					),
				db
					.insert(creditLedger)
					.values({
						id: crypto.randomUUID(),
						userId,
						amount: diff,
						type: "grant_upgrade",
						requestId,
						periodMonth: month,
						tokenAmount: null,
					})
					.onConflictDoNothing({ target: creditLedger.requestId }),
			]);
			continue;
		}
		// 当月未付与(新月 / 残高行なし)。現プランの付与額でリセット付与する
		const requestId = grantRequestId(userId, month);
		units.push([
			db
				.insert(creditLedger)
				.values({
					id: crypto.randomUUID(),
					userId,
					amount: target,
					type: "grant",
					requestId,
					periodMonth: month,
					tokenAmount: null,
				})
				.onConflictDoNothing({ target: creditLedger.requestId }),
			db
				.insert(creditBalance)
				.values({ userId, balance: target, periodMonth: month })
				.onConflictDoUpdate({
					target: creditBalance.userId,
					set: { balance: target, periodMonth: month, updatedAt: new Date() },
					// 別リクエストが既に当月へリセット済みなら上書きしない(消費の巻き戻し防止)
					setWhere: sql`${creditBalance.periodMonth} <> ${month}`,
				}),
		]);
	}
	await runInChunkedBatches(units);
}

export async function ensureCurrentMonthGranted(userId: string): Promise<void> {
	const month = currentMonthKey();
	const existing = await db
		.select({ periodMonth: creditBalance.periodMonth })
		.from(creditBalance)
		.where(eq(creditBalance.userId, userId))
		.limit(1);

	// 現プランでの当月付与目標額。昇格検知にも使うため高速パスの前に確定する。
	const isPremium = await billingService.isPremiumUser(userId);
	const target = monthlyGrantForPlan(isPremium);

	if (existing[0]?.periodMonth === month) {
		await topUpMidMonthUpgrade(userId, month, target);
		return;
	}

	const requestId = grantRequestId(userId, month);
	await db.batch([
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount: target,
				type: "grant",
				requestId,
				periodMonth: month,
				tokenAmount: null,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
		db
			.insert(creditBalance)
			.values({ userId, balance: target, periodMonth: month })
			.onConflictDoUpdate({
				target: creditBalance.userId,
				set: { balance: target, periodMonth: month, updatedAt: new Date() },
				// 別リクエストが既に当月へリセット済みなら上書きしない(消費の巻き戻し防止)
				setWhere: sql`${creditBalance.periodMonth} <> ${month}`,
			}),
	]);
}

/**
 * 月途中のプラン昇格でクレジットが不足する問題(#142)への差分付与。当月が既に付与済み
 * (残高行が当月)であることを前提に呼ぶ。当月の累計付与額(grant + grant_upgrade)が
 * 現プランの付与目標に満たなければ、その差分を残高へ加算し grant_upgrade 台帳に記録する。
 *
 * 冪等性は grant_upgrade:{userId}:{month}:{target} の unique 制約で担保する。残高加算は
 * 「まだ台帳にこの requestId が無い時だけ」に条件付け(台帳 INSERT より前に評価)し、再実行
 * しても二重加算しない(admin-actions.grantCredits と同じパターン)。
 *
 * **キーに target を含めるのが要点**(#387)。以前の `grant_upgrade:{userId}:{month}` 固定は
 * 「無料↔プレミアムの2値なので昇格の差分付与は月1回で足りる」という前提に依っていたが、
 * 月次付与額の引き上げ(#383)自体がこの経路を通るため、増額で枠を使い切った後の昇格が
 * ガードに弾かれて無言で消えた。target 別のキーなら「同じ目標額への引き上げは1回だけ」に
 * なり、増額と昇格が同月に重なっても互いを潰さない。差分は常に
 * `target - 当月の累計付与額` なので、同じ target での再実行は diff<=0 で早期 return する。
 *
 * 降格時は差分が0以下となり何もしない(返却はしない)。降格後に再昇格しても累計付与額が
 * 既に target に達しているため二重付与にはならない。
 */
async function topUpMidMonthUpgrade(
	userId: string,
	month: string,
	target: number,
): Promise<void> {
	const grantedRows = await db
		.select({
			total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)`,
		})
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.periodMonth, month),
				inArray(creditLedger.type, ["grant", "grant_upgrade"]),
			),
		);
	const alreadyGranted = grantedRows[0]?.total ?? 0;
	const diff = target - alreadyGranted;
	if (diff <= 0) return;

	const requestId = grantUpgradeRequestId(userId, month, target);
	await db.batch([
		db
			.update(creditBalance)
			.set({
				balance: sql`${creditBalance.balance} + ${diff}`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(creditBalance.userId, userId),
					sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${requestId})`,
					// 月境界: 上の「当月付与済み」の読み取りとこのコミットの間に、別リクエストの
					// 月次リセットが割り込むことがある。ガードが無いと**翌月のリセット済み残高**に
					// 当月ぶんの差分が乗り、台帳(periodMonth=当月)と突合が合わなくなる(案Aでは
					// 付与が1ヶ月余分に生存する)。月が替わっていたら台帳のみ記録に倒れる。
					// settle/refund が台帳の period_month を参照して行っているのと同じ判定で、
					// grant 系は月が引数で分かっているので直接比較でよい(#403、#147 と同型)。
					eq(creditBalance.periodMonth, month),
				),
			),
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount: diff,
				type: "grant_upgrade",
				requestId,
				periodMonth: month,
				tokenAmount: null,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
	]);
}

/** 遅延付与を挟んでから現在残高を返す。残高行が無ければ 0 とみなす。 */
export async function getBalance(userId: string): Promise<CreditBalance> {
	await ensureCurrentMonthGranted(userId);
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
 * 予約: 最大見積分を consume として仮計上し、残高から引く。
 * - 同一 requestId の予約が既にあれば再計上しない(冪等)
 * - 残高が足りる時だけ引く条件付きUPDATE。空結果=残高不足でブロック(throw しない)
 *
 * 引く前に孤児予約を回収する(#246)。AI を使う唯一の入口なので、打ち切りで宙に浮いた
 * クレジットはここで戻る。残高チェックより前に置くことで、孤児のせいで残高不足になって
 * いたユーザがそのままブロックされ続けることも防ぐ。
 */
export async function reserveCredits(
	userId: string,
	estimate: CreditCharge,
	requestId: string,
): Promise<ReserveResult> {
	await ensureCurrentMonthGranted(userId);
	await reclaimOrphanReservations(userId);
	const required = costToCredits(estimate.microUsd);

	const dup = await db
		.select({ amount: creditLedger.amount })
		.from(creditLedger)
		.where(eq(creditLedger.requestId, requestId))
		.limit(1);
	if (dup[0]) {
		const cur = await getBalance(userId);
		return {
			ok: true,
			requestId,
			reservedCredits: -dup[0].amount,
			reservedMicroUsd: estimate.microUsd,
			balanceAfter: cur.balance,
		};
	}

	// 残高減算と consume 台帳追記を単一の db.batch(=1トランザクション)で原子化する。
	// これにより台帳 INSERT が D1 一時エラーで失敗しても残高減算ごとロールバックされ、
	// クレジットが台帳に痕跡なく消失することを防ぐ(#143)。残高が足りる時だけ引く条件付き
	// UPDATE の RETURNING で充足を判定する。
	//
	// **両方を同じ条件(残高 >= required)に付ける**。以前は INSERT を無条件にして、残高不足の
	// ときだけ batch の外で DELETE して打ち消していたが、その DELETE が D1 の一時エラーで
	// 失敗すると「残高は引かれていないのに consume 台帳だけ残る」行が恒久的に残った(#247)。
	// requestId はリクエストごとのUUIDなので後続リトライが回収する機会も無く、台帳SUMと
	// 残高の突合がずれ、findConsumersInRange(障害補填の対象抽出)が「実際には消費していない
	// =ブロックされたユーザ」を拾ってしまう。
	//
	// INSERT を先に置くのは、D1 の batch が1トランザクション内で**順に**実行され、後続の
	// 文が前の文の結果を見るため。UPDATE を先にすると減算後の残高で INSERT の条件を評価して
	// しまい、実質2倍の残高を要求することになる。
	const [, debited] = await db.batch([
		// INSERT ... SELECT ... FROM credit_balance WHERE (残高が足りる)。
		// 条件を満たす残高行があるときだけ1行入り、無ければ0行。
		db.insert(creditLedger).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					userId: sql<string>`${userId}`.as("user_id"),
					amount: sql<number>`${-required}`.as("amount"),
					type: sql<CreditLedgerType>`'consume'`.as("type"),
					requestId: sql<string>`${requestId}`.as("request_id"),
					periodMonth: sql<string>`${currentMonthKey()}`.as("period_month"),
					tokenAmount: sql<number>`${estimate.tokens}`.as("token_amount"),
					// INSERT ... SELECT はテーブル定義と同じ順序・同じ列数を要求するため、
					// 既定値に任せられない。schema.ts の default と同じ式を書く。
					createdAt:
						sql<number>`(cast(unixepoch('subsecond') * 1000 as integer))`.as(
							"created_at",
						),
					// schema.ts の列順(createdAt の後ろ)と揃える。
					costMicroUsd: sql<number>`${estimate.microUsd}`.as("cost_micro_usd"),
				})
				.from(creditBalance)
				.where(
					and(
						eq(creditBalance.userId, userId),
						sql`${creditBalance.balance} >= ${required}`,
					),
				),
		),
		db
			.update(creditBalance)
			.set({ balance: sql`${creditBalance.balance} - ${required}` })
			.where(
				and(
					eq(creditBalance.userId, userId),
					sql`${creditBalance.balance} >= ${required}`,
				),
			)
			.returning({ balance: creditBalance.balance }),
	]);
	if (!debited[0]) {
		// 残高不足。INSERT も同じ条件で弾かれているので台帳には何も入っておらず、
		// 打ち消しは不要(ユーザ不利も生じない)。
		const cur = await getBalance(userId);
		return {
			ok: false,
			reason: "insufficient",
			balance: cur.balance,
			required,
		};
	}

	return {
		ok: true,
		requestId,
		reservedCredits: required,
		reservedMicroUsd: estimate.microUsd,
		balanceAfter: debited[0].balance,
	};
}

/**
 * 予約のマーカー(`:settle` / `:refund`)を、**相手側マーカーがまだ無いときだけ**書く INSERT。
 *
 * settle と refund は相互排他で、「先に記録された方が勝つ・どちらも残高を二重に動かさない」
 * が不変条件(docs/ai-credit-system.md)。しかし呼び出し前の事前 SELECT だけでは、確認から
 * コミットまでの間に相手側(孤児回収の refund / 生き延びたリクエストの settle)がコミットする
 * 窓が残る(#335)。そこで予約の consume 行を1行だけ引く `INSERT ... SELECT` にして、相手側の
 * 不存在を**この文の中で**評価する。負けた側は台帳にも残高にも何も書かない。
 *
 * 残高 UPDATE 側にも同じ相手側ガードを置く(下記)。両方を db.batch(=暗黙トランザクション)に
 * 載せることで、相互排他がバッチの外の状態に依存しなくなる。
 */
function reservationMarkerInsert(params: {
	userId: string;
	/** 予約の requestId(consume 行のキー)。 */
	requestId: string;
	/** 書き込むマーカーの requestId。 */
	markerId: string;
	/** 相手側マーカーの requestId。これが既にあれば1行も書かない。 */
	counterpartId: string;
	amount: number;
	tokenAmount: number | null;
	/** 量子化前の実原価(µUSD)。返却(全額戻し)は原価を伴わないので null。 */
	costMicroUsd: number | null;
}) {
	const {
		userId,
		requestId,
		markerId,
		counterpartId,
		amount,
		tokenAmount,
		costMicroUsd,
	} = params;
	const month = currentMonthKey();
	return db
		.insert(creditLedger)
		.select((qb) =>
			qb
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					userId: sql<string>`${userId}`.as("user_id"),
					amount: sql<number>`${amount}`.as("amount"),
					// settle も refund も台帳種別は "refund"(残高を戻す向き)。
					type: sql<CreditLedgerType>`${"refund" satisfies CreditLedgerType}`.as(
						"type",
					),
					requestId: sql<string>`${markerId}`.as("request_id"),
					periodMonth: sql<string>`${month}`.as("period_month"),
					tokenAmount: sql<number | null>`${tokenAmount}`.as("token_amount"),
					// INSERT ... SELECT では列の既定値が効かないため、スキーマと同じ式を置く。
					// (drizzle は「テーブル定義と同じ並びの全列」を要求する)
					createdAt:
						sql<Date>`(cast(unixepoch('subsecond') * 1000 as integer))`.as(
							"created_at",
						),
					// schema.ts の列順(createdAt の後ろ)と揃える。
					costMicroUsd: sql<number | null>`${costMicroUsd}`.as(
						"cost_micro_usd",
					),
				})
				// 「その予約の consume 行が在り、かつ相手側マーカーが無い」ときだけ1行になる。
				.from(creditLedger)
				.where(
					and(
						eq(creditLedger.requestId, requestId),
						eq(creditLedger.type, "consume"),
						sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${counterpartId})`,
					),
				)
				.limit(1),
		)
		.onConflictDoNothing({ target: creditLedger.requestId });
}

/**
 * 確定: 実測トークンで予約との差分を refund として戻す。
 *
 * 差分が0でも `:settle` 台帳を amount=0 で必ず記録する。この行は「この予約は確定済み」の
 * 唯一の証跡で、
 *  - 確定後に返却が呼ばれた時の二重返却ガード(#144)。差分0の確定で行が無いと、この
 *    ガードが素通りして予約全額が追加返却される
 *  - 孤児予約の検出(#246)。確定済みと打ち切られた予約を区別する唯一の手掛かり
 * の両方が成立するために要る。実測トークンの記録先でもある。
 */
export async function settleReservation(
	userId: string,
	requestId: string,
	reservedCredits: number,
	actual: CreditCharge,
): Promise<void> {
	const back = refundCredits(reservedCredits, actual.microUsd);
	const settleId = settleRequestId(requestId);
	const refundId = refundRequestId(requestId);

	// 既に返却済みなら確定しない。孤児回収(#246)が予約全額を戻した後に、生き延びていた
	// リクエストが差分を足すと消費がネットプラスになる(refundReservation の逆向きガード)。
	const refunded = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(eq(creditLedger.requestId, refundId))
		.limit(1);
	if (refunded[0]) {
		logWarn("settle skipped: reservation already refunded", {
			userId,
			requestId,
		});
		return;
	}

	const marker = reservationMarkerInsert({
		userId,
		requestId,
		markerId: settleId,
		counterpartId: refundId,
		amount: back,
		tokenAmount: actual.tokens,
		costMicroUsd: actual.microUsd,
	});

	// 戻す差分が無い場合は残高を触らず証跡だけ残す(balance + 0 の無駄な書き込みを避ける)。
	if (back <= 0) {
		await keepAlive(marker);
		return;
	}

	// UPDATE を先に置き、ガードが settle 台帳の INSERT 前の状態を見るようにする
	// (admin-actions.grantCredits と同じ順序)。
	await keepAlive(
		db.batch([
			db
				.update(creditBalance)
				.set({ balance: sql`${creditBalance.balance} + ${back}` })
				.where(
					and(
						eq(creditBalance.userId, userId),
						// 二重加算防止: 既に settle 台帳がある(=加算済み)なら加算しない(#146)。
						sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${settleId})`,
						// 相互排他: 返却済みなら差分を足さない(#335)。事前 SELECT と同じ判定を
						// バッチ内でも行い、確認〜コミットの間に孤児回収の refund が割り込む窓を塞ぐ。
						sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${refundId})`,
						// 月境界: 予約(consume)の月と現残高の月が一致する時だけ加算する。月替わり後は
						// 台帳のみ記録し、リセット後の残高に差分が混入する/超過することを防ぐ(#147)。
						sql`${creditBalance.periodMonth} = (SELECT period_month FROM credit_ledger WHERE request_id = ${requestId} AND type = 'consume')`,
					),
				),
			marker,
		]),
	);
}

/**
 * 失敗補償: 予約を返却し、その成否を requestId 付きで記録する。返却自体が D1 障害で
 * 失敗しても throw せずログに留め、呼び出し側が本来の失敗例外を伝播できるようにする。
 * これが無いと、AI失敗+返却失敗が重なった際に元の失敗例外が握り潰され、クレジット消失が
 * 無記録になる(#158)。台帳(credit_ledger)との突合用に返却成功も logInfo で残す。
 */
export async function refundReservationOnFailure(
	userId: string,
	requestId: string,
	reservedCredits: number,
): Promise<void> {
	try {
		await refundReservation(userId, requestId, reservedCredits);
		if (reservedCredits > 0) {
			logInfo("inference failed; reservation refunded", {
				userId,
				requestId,
				reservedCredits,
			});
		}
	} catch (refundErr) {
		logError("credit refund failed after inference error", {
			userId,
			requestId,
			reservedCredits,
			err: refundErr,
		});
	}
}

/** 失敗時: 予約全額を refund として戻す。 */
export async function refundReservation(
	userId: string,
	requestId: string,
	reservedCredits: number,
): Promise<void> {
	if (reservedCredits <= 0) return;
	const settleId = settleRequestId(requestId);
	// 既に settle 済み(=消費確定済み)なら返却しない。settle 後に本関数が呼ばれても
	// 予約全額を追加返却して消費がネットプラスになる事故を防ぐ(#144)。
	const settled = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(eq(creditLedger.requestId, settleId))
		.limit(1);
	if (settled[0]) {
		logWarn("refund skipped: reservation already settled", {
			userId,
			requestId,
		});
		return;
	}
	const refundId = refundRequestId(requestId);
	// UPDATE を先に置き、ガードが refund 台帳の INSERT 前の状態を見るようにする。
	await keepAlive(
		db.batch([
			db
				.update(creditBalance)
				.set({ balance: sql`${creditBalance.balance} + ${reservedCredits}` })
				.where(
					and(
						eq(creditBalance.userId, userId),
						// 二重加算防止: 既に refund 台帳がある(=返却済み)なら加算しない(#146)。
						sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${refundId})`,
						// 相互排他: 確定済みなら全額返却しない(#335)。事前 SELECT と同じ判定を
						// バッチ内でも行い、確認〜コミットの間に settle が割り込む窓を塞ぐ。
						sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${settleId})`,
						// 月境界: 予約(consume)の月と現残高の月が一致する時だけ加算する(#147)。
						sql`${creditBalance.periodMonth} = (SELECT period_month FROM credit_ledger WHERE request_id = ${requestId} AND type = 'consume')`,
					),
				),
			reservationMarkerInsert({
				userId,
				requestId,
				markerId: refundId,
				counterpartId: settleId,
				amount: reservedCredits,
				tokenAmount: null,
				// 全額返却は「消費が無かった」ことの記録なので原価も持たない。
				costMicroUsd: null,
			}),
		]),
	);
}

/**
 * 打ち切りで孤児化した予約(=一定時間が経っても `:settle` も `:refund` も付いていない
 * consume)を洗い出して返却する遅延修復(#246)。
 *
 * Workers はクライアント切断・isolate 強制終了・デプロイ入替でリクエストを打ち切りうる。
 * keepAlive で後始末は完走させるが、AI 実行そのものが打ち切られた場合は catch にも
 * 到達しないため、予約したクレジットが台帳上「消費」のまま宙に浮く。月次リセットまで
 * 残高が戻らないので、次に予約する時にまとめて回収する。
 *
 * Cron は使わない。付与を `ensureCurrentMonthGranted` の遅延実行で賄っている設計
 * (docs/ai-credit-system.md)に合わせ、入口でのついで回収にする。
 *
 * 検出の健全性は「確定した予約には必ず `:settle` 行がある」ことに依る。差分0の確定でも
 * settleReservation が amount=0 の証跡を残し、本変更以前の既存行は drizzle/0020 が
 * 確定済みとして補填しているため、正常に消費された予約を誤って返却することはない。
 *
 * 失敗しても呼び出し側の処理は止めない(回収は best-effort。次の機会に再試行される)。
 */
export async function reclaimOrphanReservations(userId: string): Promise<void> {
	const now = Date.now();
	const month = currentMonthKey();
	let orphans: Array<{ requestId: string; amount: number }>;
	try {
		orphans = await db
			.select({
				requestId: creditLedger.requestId,
				amount: creditLedger.amount,
			})
			.from(creditLedger)
			.where(
				and(
					eq(creditLedger.userId, userId),
					eq(creditLedger.type, "consume"),
					// 返却が残高に反映されるのは予約と同じ付与月の間だけ(#147)。過去月の
					// 孤児を拾っても台帳ノイズが増えるだけなので当月に絞る。
					eq(creditLedger.periodMonth, month),
					// 索引(user_id, created_at)のレンジで候補を絞る。下限が無いと全期間走査になる。
					gte(creditLedger.createdAt, new Date(now - ORPHAN_SCAN_WINDOW_MS)),
					// 実行中のリクエストの予約を回収しないための猶予。
					lt(creditLedger.createdAt, new Date(now - ORPHAN_GRACE_MS)),
					sql`NOT EXISTS (SELECT 1 FROM credit_ledger m WHERE m.request_id = ${creditLedger.requestId} || ${SETTLE_SUFFIX})`,
					sql`NOT EXISTS (SELECT 1 FROM credit_ledger m WHERE m.request_id = ${creditLedger.requestId} || ${REFUND_SUFFIX})`,
				),
			)
			.orderBy(asc(creditLedger.createdAt))
			.limit(ORPHAN_RECLAIM_LIMIT);
	} catch (err) {
		logError("orphan reservation scan failed", { userId, err });
		return;
	}

	for (const orphan of orphans) {
		// consume の amount は負。返却額は符号を戻した絶対値。
		const reservedCredits = -orphan.amount;
		try {
			await refundReservation(userId, orphan.requestId, reservedCredits);
			logInfo("orphan reservation reclaimed", {
				userId,
				requestId: orphan.requestId,
				reservedCredits,
			});
		} catch (err) {
			// 1件の失敗で残りを諦めない(次の機会にも再度候補に挙がる)。
			logError("orphan reservation reclaim failed", {
				userId,
				requestId: orphan.requestId,
				reservedCredits,
				err,
			});
		}
	}
}
