import { env as testEnv } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { subscription, user } from "#/db/auth-schema";
import { creditBalance, creditLedger } from "#/db/schema";
import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
	TOKENS_PER_CREDIT,
} from "#/lib/billing/plans";
import { currentMonthKey } from "#/lib/credit/month";
import type { CreditLedgerType } from "#/lib/credit/types";
import {
	type BatchUnit,
	ensureCurrentMonthGranted,
	getBalance,
	reclaimOrphanReservations,
	refundReservation,
	reserveCredits,
	runInChunkedBatches,
	settleReservation,
} from "./credit-service";

// D1(実SQLite)上で credit-service の付与ロジックを検証する。特に月途中のプレミアム
// 昇格で当月クレジットを差分付与する挙動(#142)を、実際にクエリを走らせて確認する。

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `credit-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "credit tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

/** ユーザを有効なプレミアム会員にする(isPremiumUser が true を返すよう subscription を投入)。 */
async function makePremium(userId: string): Promise<void> {
	await db.insert(subscription).values({
		id: `sub-${userId}`,
		plan: "premium",
		referenceId: userId,
		status: "active",
	});
}

async function ledgerRows(userId: string, type: CreditLedgerType) {
	return db
		.select()
		.from(creditLedger)
		.where(and(eq(creditLedger.userId, userId), eq(creditLedger.type, type)));
}

/** 残高キャッシュを直接読む(getBalance と違い遅延付与を発火させない)。 */
async function readBalance(userId: string): Promise<number> {
	const rows = await db
		.select({ balance: creditBalance.balance })
		.from(creditBalance)
		.where(eq(creditBalance.userId, userId))
		.limit(1);
	return rows[0]?.balance ?? 0;
}

async function ledgerByRequestId(requestId: string) {
	return db
		.select()
		.from(creditLedger)
		.where(eq(creditLedger.requestId, requestId));
}

describe("ensureCurrentMonthGranted", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("無料会員に当月分(FREE)を付与し grant 台帳を1本作る", async () => {
		await ensureCurrentMonthGranted(userId);

		const bal = await getBalance(userId);
		expect(bal.balance).toBe(MONTHLY_CREDITS_FREE);
		expect(bal.periodMonth).toBe(currentMonthKey());

		const grants = await ledgerRows(userId, "grant");
		expect(grants).toHaveLength(1);
		expect(grants[0]?.amount).toBe(MONTHLY_CREDITS_FREE);
		// 昇格していないので grant_upgrade は発生しない。
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(0);
	});

	it("月途中のプレミアム昇格で不足分(PREMIUM-FREE)を差分付与する(#142)", async () => {
		// 無料会員として当月分(FREE)を先に付与済みにする。
		await ensureCurrentMonthGranted(userId);
		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_FREE);

		// 月の途中でプレミアムに昇格。
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);

		// 残高はプレミアムの付与額まで底上げされる。
		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_PREMIUM);

		const upgrades = await ledgerRows(userId, "grant_upgrade");
		expect(upgrades).toHaveLength(1);
		expect(upgrades[0]?.amount).toBe(
			MONTHLY_CREDITS_PREMIUM - MONTHLY_CREDITS_FREE,
		);
		expect(upgrades[0]?.requestId).toBe(
			`grant_upgrade:${userId}:${currentMonthKey()}`,
		);
	});

	it("差分付与は冪等: 昇格後に再実行しても二重に加算しない", async () => {
		await ensureCurrentMonthGranted(userId);
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);
		// 何度呼んでも残高・台帳は変わらない。
		await ensureCurrentMonthGranted(userId);
		await ensureCurrentMonthGranted(userId);

		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_PREMIUM);
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(1);
	});

	it("昇格前に消費していても、消費分を巻き戻さずに差分だけ加算する", async () => {
		await ensureCurrentMonthGranted(userId);
		// FREE(50) のうち 30 クレジット分(30,000 トークン)を消費予約する。
		const reserved = await reserveCredits(userId, 30_000, `req-${userId}`);
		expect(reserved.ok).toBe(true);
		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_FREE - 30);

		// 昇格 → 差分(PREMIUM-FREE=450)のみ加算され、消費済みの30は戻らない。
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);

		expect((await getBalance(userId)).balance).toBe(
			MONTHLY_CREDITS_FREE -
				30 +
				(MONTHLY_CREDITS_PREMIUM - MONTHLY_CREDITS_FREE),
		);
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(1);
	});

	it("プレミアム会員として初回付与された場合は grant_upgrade を発生させない", async () => {
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);

		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_PREMIUM);
		const grants = await ledgerRows(userId, "grant");
		expect(grants).toHaveLength(1);
		expect(grants[0]?.amount).toBe(MONTHLY_CREDITS_PREMIUM);
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(0);
	});
});

describe("getBalance / reserveCredits", () => {
	it("残高行が無いユーザでも遅延付与を挟んで残高を返す", async () => {
		const userId = await freshUser();
		const bal = await getBalance(userId);
		expect(bal.balance).toBe(MONTHLY_CREDITS_FREE);
	});
});

describe("reserveCredits の原子性・冪等性 (#143)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("残高不足の予約は残高を引かず consume 台帳も残さない", async () => {
		// FREE=50 に対し 60 クレジット(60,000トークン)を要求 → 不足。
		const requestId = `insufficient-${userId}`;
		const res = await reserveCredits(userId, 60_000, requestId);

		expect(res.ok).toBe(false);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		// consume 行はそもそも入らない(残高UPDATEと同じ条件で INSERT を弾く)。
		// 以前は無条件に入れて batch の外の DELETE で打ち消していたため、その DELETE が
		// 失敗すると幽霊 consume が恒久的に残った(#247)。
		expect(await ledgerByRequestId(requestId)).toHaveLength(0);
	});

	it("残高ちょうどの予約は通り、consume 台帳が1本だけ入る (#247)", async () => {
		// 境界値。台帳INSERTの条件が「減算後」の残高で評価されると、ここで残高だけ引かれて
		// 台帳が入らない(=消費の痕跡が消える)ため、文の実行順序の退行をここで検出する。
		const requestId = `exact-${userId}`;
		const res = await reserveCredits(
			userId,
			MONTHLY_CREDITS_FREE * TOKENS_PER_CREDIT,
			requestId,
		);

		expect(res.ok).toBe(true);
		expect(await readBalance(userId)).toBe(0);
		const rows = await ledgerByRequestId(requestId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.amount).toBe(-MONTHLY_CREDITS_FREE);
	});

	it("ブロックされた予約を挟んでも台帳の合計と残高が一致する (#247)", async () => {
		// 「台帳=真実」の前提。幽霊 consume が残ると SUM が残高より小さくなり、
		// 障害補填の対象抽出(findConsumersInRange)が実際には消費していないユーザを拾う。
		await reserveCredits(userId, 60_000, `blocked-${userId}`);
		await reserveCredits(userId, 10_000, `ok-${userId}`);

		const all = await db
			.select({ amount: creditLedger.amount })
			.from(creditLedger)
			.where(eq(creditLedger.userId, userId));
		const sum = all.reduce((acc, r) => acc + r.amount, 0);

		expect(sum).toBe(await readBalance(userId));
		expect(sum).toBe(MONTHLY_CREDITS_FREE - 10);
	});

	it("同一 requestId の再予約は二重に引かない(冪等)", async () => {
		const requestId = `dup-${userId}`;
		await reserveCredits(userId, 30_000, requestId);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);

		// 同じ requestId でもう一度呼んでも残高は変わらず、consume 台帳も1本のまま。
		const again = await reserveCredits(userId, 30_000, requestId);
		expect(again.ok).toBe(true);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
		expect(await ledgerByRequestId(requestId)).toHaveLength(1);
	});
});

describe("settleReservation のガード (#146/#147)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("確定の差分返却は一度だけ反映し、二重呼び出しで二重加算しない(#146)", async () => {
		const requestId = `settle-${userId}`;
		// 30 クレジット予約(残高 50→20)。実測 10 クレジット → 差分 20 を返却。
		await reserveCredits(userId, 30_000, requestId);
		await settleReservation(userId, requestId, 30, 10_000);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);

		// 同一 requestId の再確定は残高を動かさない。
		await settleReservation(userId, requestId, 30, 10_000);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);
		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(1);
	});

	it("予約の月と現残高の月が異なる場合は残高へ加算せず台帳のみ記録する(#147)", async () => {
		// 残高は beforeEach の遅延付与で当月(NEW)にリセット済み。そこへ「先月(OLD)に
		// 行われた予約」の consume 台帳を差し込み、月をまたいだ確定を再現する。
		const oldMonth = "2000-01";
		const requestId = `settle-monthboundary-${userId}`;
		await db.insert(creditLedger).values({
			id: `consume-${requestId}`,
			userId,
			amount: -30,
			type: "consume",
			requestId,
			periodMonth: oldMonth,
			tokenAmount: 30_000,
		});

		await settleReservation(userId, requestId, 30, 10_000);

		// 残高は据え置き(リセット後残高への差分混入・超過を防ぐ)。台帳の :settle は記録される。
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(1);
	});
});

describe("refundReservation のガード (#144/#146)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("settle 済みの予約は返却をスキップする(消費のネットプラス防止・#144)", async () => {
		const requestId = `refund-settled-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await settleReservation(userId, requestId, 30, 10_000); // +20 → 40

		// settle 後に返却が呼ばれても全額返却しない。
		await refundReservation(userId, requestId, 30);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("通常の返却は反映し、二重返却で二重加算しない(#146)", async () => {
		const requestId = `refund-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await refundReservation(userId, requestId, 30); // +30 → 50
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);

		await refundReservation(userId, requestId, 30);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(1);
	});
});

// --- 孤児予約の回収 (#246) -------------------------------------------------
//
// 打ち切り(クライアント切断・isolate 強制終了)で確定も返却もされなかった予約を、
// 次の予約時に回収する挙動を実D1で検証する。「猶予を過ぎた」状態は created_at を
// 直接過去へ倒して作る(テストで実時間を待たないため)。

/** 予約(consume)台帳の作成時刻を指定ミリ秒だけ過去へ倒す。 */
async function ageReservation(requestId: string, ms: number): Promise<void> {
	await db
		.update(creditLedger)
		.set({ createdAt: new Date(Date.now() - ms) })
		.where(
			and(
				eq(creditLedger.requestId, requestId),
				eq(creditLedger.type, "consume"),
			),
		);
}

/** 回収の猶予(10分)を確実に超える経過時間。 */
const PAST_GRACE_MS = 30 * 60 * 1000;

describe("reclaimOrphanReservations (#246)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("猶予を過ぎても確定も返却もされていない予約を返却する", async () => {
		const requestId = `orphan-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await ageReservation(requestId, PAST_GRACE_MS);

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(1);
	});

	it("猶予内の予約は回収しない(実行中のリクエストを奪わない)", async () => {
		const requestId = `inflight-${userId}`;
		await reserveCredits(userId, 30_000, requestId);
		// created_at は現在時刻のまま(=まだ実行中とみなす)。

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("確定済み(差分返却あり)の予約は回収しない", async () => {
		const requestId = `settled-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await settleReservation(userId, requestId, 30, 10_000); // +20 → 40
		await ageReservation(requestId, PAST_GRACE_MS);

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("差分0で確定した予約(実測=見積)も回収しない", async () => {
		// 実測トークンが取れないモデルでは actualTokens=予約全量となり返却は0になる。
		// この場合も :settle の証跡が残らないと、正常な消費を孤児と誤判定して二重取りに
		// なる。settleReservation が amount=0 の行を残すことがこのケースの防波堤。
		const requestId = `settled-zero-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await settleReservation(userId, requestId, 30, 30_000); // 差分0
		await ageReservation(requestId, PAST_GRACE_MS);

		const settleRows = await ledgerByRequestId(`${requestId}:settle`);
		expect(settleRows).toHaveLength(1);
		expect(settleRows[0]?.amount).toBe(0);
		// 実測トークンは差分0でも記録しておく(監査用)。
		expect(settleRows[0]?.tokenAmount).toBe(30_000);

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("既に返却済みの予約を二重に返却しない", async () => {
		const requestId = `already-refunded-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await refundReservation(userId, requestId, 30); // +30 → 50
		await ageReservation(requestId, PAST_GRACE_MS);

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(1);
	});

	it("過去月の孤児は残高へ加算しない(月境界・#147)", async () => {
		// 先月の予約が孤児のまま残っているところへ当月の残高がリセットされた状態。
		const requestId = `orphan-oldmonth-${userId}`;
		await db.insert(creditLedger).values({
			id: `consume-${requestId}`,
			userId,
			amount: -30,
			type: "consume",
			requestId,
			periodMonth: "2000-01",
			tokenAmount: 30_000,
			createdAt: new Date(Date.now() - PAST_GRACE_MS),
		});

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("1回の回収は上限件数までに抑える", async () => {
		// 上限(10)を超える孤児を作り、1回の呼び出しで全部は処理しないことを確認する。
		// 予約をすべて済ませてから一括で過去へ倒す(reserveCredits 自体が回収を挟むため、
		// 1件ずつ倒すと次の予約でその都度回収されてしまう)。
		const requestIds = Array.from(
			{ length: 12 },
			(_, i) => `orphan-many-${userId}-${i}`,
		);
		for (const requestId of requestIds) {
			await reserveCredits(userId, 1_000, requestId); // 1クレジットずつ
		}
		for (const requestId of requestIds) {
			await ageReservation(requestId, PAST_GRACE_MS);
		}
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 12);

		await reclaimOrphanReservations(userId);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 2);

		// 残りは次の機会に回収される。
		await reclaimOrphanReservations(userId);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
	});

	it("予約の入口で回収が走り、孤児のせいで残高不足だったユーザがブロックされない", async () => {
		// FREE=50 のうち 40 を孤児として失った状態。次の 30 クレジットの予約は、
		// 回収が無ければ残高10で不足ブロックになる。
		const orphanId = `orphan-blocking-${userId}`;
		await reserveCredits(userId, 40_000, orphanId);
		await ageReservation(orphanId, PAST_GRACE_MS);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 40);

		const res = await reserveCredits(userId, 30_000, `next-${userId}`);

		expect(res.ok).toBe(true);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
		expect(await ledgerByRequestId(`${orphanId}:refund`)).toHaveLength(1);
	});
});

describe("settleReservation の返却済みガード (#246)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("返却済みの予約は確定しない(消費のネットプラス防止)", async () => {
		// 回収が予約全額を返却した後に、生き延びていたリクエストが確定を試みる競合。
		const requestId = `settle-after-refund-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await refundReservation(userId, requestId, 30); // +30 → 50

		await settleReservation(userId, requestId, 30, 10_000);

		// 差分20が上乗せされず、返却後の残高のまま。
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(0);
	});
});

// --- 既存データの補填マイグレーション (drizzle/0020) ------------------------
//
// 回収の健全性は「確定した予約には必ず :settle 行がある」ことに依るが、本変更以前は
// 差分0の確定が台帳に何も書かなかった。0020 はその積み残しを「確定済み」として塗り潰し、
// 正常に消費し切った予約が回収(=二重取り)されないようにする。SQL 自体を実D1で走らせて
// 検証する(マイグレーション本体は vitest.config.ts が TEST_MIGRATIONS に載せている)。

/** drizzle/0020 の SQL を現在のテスト用D1へ適用する。 */
async function applyOrphanBackfill(): Promise<void> {
	const migration = testEnv.TEST_MIGRATIONS.find((m) =>
		m.name.startsWith("0020_"),
	);
	if (!migration) throw new Error("drizzle/0020 が TEST_MIGRATIONS に無い");
	for (const query of migration.queries) {
		await testEnv.DB.prepare(query).run();
	}
}

describe("drizzle/0020 既存予約の確定マーカー補填 (#246)", () => {
	let userId: string;
	let requestId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
		// 本変更以前に「差分0で確定した予約」を再現する: consume だけがあり、
		// :settle も :refund も無い(= 孤児と見分けが付かない)状態。
		requestId = `legacy-settled-${userId}`;
		await db.batch([
			db.insert(creditLedger).values({
				id: `consume-${requestId}`,
				userId,
				amount: -30,
				type: "consume",
				requestId,
				periodMonth: currentMonthKey(),
				tokenAmount: 30_000,
				createdAt: new Date(Date.now() - PAST_GRACE_MS),
			}),
			db
				.update(creditBalance)
				.set({ balance: MONTHLY_CREDITS_FREE - 30 })
				.where(eq(creditBalance.userId, userId)),
		]);
	});

	it("未確定の consume に :settle マーカー(amount=0)を補う", async () => {
		await applyOrphanBackfill();

		const marker = await ledgerByRequestId(`${requestId}:settle`);
		expect(marker).toHaveLength(1);
		expect(marker[0]?.amount).toBe(0);
		expect(marker[0]?.userId).toBe(userId);
		// 元の consume の付与月を引き継ぐ(月境界ガードの参照先と整合させる)。
		expect(marker[0]?.periodMonth).toBe(currentMonthKey());
		// 残高は動かさない(既に引かれたままで据え置く)。
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
	});

	it("補填後は回収の対象にならない(クレジットの二重取りを防ぐ)", async () => {
		await applyOrphanBackfill();

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("冪等: 再適用してもマーカーは増えない", async () => {
		await applyOrphanBackfill();
		await applyOrphanBackfill();

		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(1);
	});

	it("返却済みの予約にはマーカーを付けない(返却が確定に化けない)", async () => {
		const refundedId = `legacy-refunded-${userId}`;
		await db.insert(creditLedger).values({
			id: `consume-${refundedId}`,
			userId,
			amount: -10,
			type: "consume",
			requestId: refundedId,
			periodMonth: currentMonthKey(),
			tokenAmount: 10_000,
		});
		await db.insert(creditLedger).values({
			id: `refund-${refundedId}`,
			userId,
			amount: 10,
			type: "refund",
			requestId: `${refundedId}:refund`,
			periodMonth: currentMonthKey(),
			tokenAmount: null,
		});

		await applyOrphanBackfill();

		expect(await ledgerByRequestId(`${refundedId}:settle`)).toHaveLength(0);
	});
});

// #334 の回帰。runInChunkedBatches はかつてフラットな文配列を上限100で単純スライスして
// いたため、1ユニットの文数が100の約数でないと(一括付与は1ユーザ3文)境界のユニットだけが
// 別 batch に割れ、「残高だけ加算され台帳行が無い」ユーザを作りうる。その状態は台帳を見る
// 冪等ガードをすり抜けるので、復旧の再実行がそのユーザだけ二重加算になる。
describe("runInChunkedBatches のチャンク境界 (#334)", () => {
	/** batch に積めるだけの軽い文を1本作る(内容は問わない)。 */
	function noopStatement(tag: string) {
		return db
			.select({ userId: creditBalance.userId })
			.from(creditBalance)
			.where(eq(creditBalance.userId, tag));
	}

	async function batchSizesOf(units: BatchUnit[]): Promise<number[]> {
		const batchSpy = vi.spyOn(testEnv.DB, "batch");
		try {
			await runInChunkedBatches(units);
			return batchSpy.mock.calls.map((call) => call[0].length);
		} finally {
			batchSpy.mockRestore();
		}
	}

	it("1ユニット3文が上限の境界で分断されない", async () => {
		const unitSize = 3;
		const units: BatchUnit[] = Array.from({ length: 40 }, (_, i) =>
			Array.from({ length: unitSize }, (_v, j) =>
				noopStatement(`chunk-${i}-${j}`),
			),
		);

		const sizes = await batchSizesOf(units);

		// 120文なので必ず複数チャンクに割れる(=境界が存在する条件で検証している)
		expect(sizes.length).toBeGreaterThan(1);
		for (const size of sizes) {
			expect(size % unitSize).toBe(0);
			expect(size).toBeLessThanOrEqual(100);
		}
		expect(sizes.reduce((a, b) => a + b, 0)).toBe(unitSize * units.length);
	});

	it("上限を超えるユニットは、上限より原子性を優先して単独の batch にする", async () => {
		const big: BatchUnit = Array.from({ length: 120 }, (_v, i) =>
			noopStatement(`big-${i}`),
		);
		const small: BatchUnit = [noopStatement("small")];

		const sizes = await batchSizesOf([big, small]);

		expect(sizes).toEqual([120, 1]);
	});
});
