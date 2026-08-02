import { env as testEnv } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { subscription, user } from "#/db/auth-schema";
import { creditBalance, creditLedger } from "#/db/schema";
import { MICRO_USD_PER_CREDIT } from "#/lib/billing/ai-pricing";
import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";
import { currentMonthKey } from "#/lib/credit/month";
import type { CreditLedgerType } from "#/lib/credit/types";
import {
	ensureCurrentMonthGranted,
	getBalance,
	reclaimOrphanReservations,
	refundReservation,
	reserveCredits,
	settleReservation,
} from "./credit-service";

// D1(実SQLite)上で credit-service の付与ロジックを検証する。特に月途中のプレミアム
// 昇格で当月クレジットを差分付与する挙動(#142)を、実際にクエリを走らせて確認する。

/**
 * 計上量の組み立て。クレジットを決めるのは `microUsd` だけで、`tokens` は台帳に残る
 * 観測値(#355)。このテストは残高の増減が関心なので、両方に同じ値を入れて
 * 「µUSD が N ならクレジットは ceil(N / MICRO_USD_PER_CREDIT)」だけを見る。
 */
const charge = (microUsd: number) => ({ microUsd, tokens: microUsd });

/** 無料会員の月次付与を必ず超えるコスト(残高不足を作るための値)。 */
const OVER_GRANT = (MONTHLY_CREDITS_FREE + 10) * MICRO_USD_PER_CREDIT;

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
		const reserved = await reserveCredits(
			userId,
			charge(30_000),
			`req-${userId}`,
		);
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
		// 付与額を必ず超える要求。**定数から導く**ことで、付与額を変えたときに
		// 「不足のはずが足りてしまい、テストが何も検証しなくなる」ことを防ぐ。
		const requestId = `insufficient-${userId}`;
		const res = await reserveCredits(userId, charge(OVER_GRANT), requestId);

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
			charge(MONTHLY_CREDITS_FREE * MICRO_USD_PER_CREDIT),
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
		await reserveCredits(userId, charge(OVER_GRANT), `blocked-${userId}`);
		await reserveCredits(userId, charge(10_000), `ok-${userId}`);

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
		await reserveCredits(userId, charge(30_000), requestId);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);

		// 同じ requestId でもう一度呼んでも残高は変わらず、consume 台帳も1本のまま。
		const again = await reserveCredits(userId, charge(30_000), requestId);
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
		await reserveCredits(userId, charge(30_000), requestId);
		await settleReservation(userId, requestId, 30, charge(10_000));
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);

		// 同一 requestId の再確定は残高を動かさない。
		await settleReservation(userId, requestId, 30, charge(10_000));
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

		await settleReservation(userId, requestId, 30, charge(10_000));

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
		await reserveCredits(userId, charge(30_000), requestId); // 50→20
		await settleReservation(userId, requestId, 30, charge(10_000)); // +20 → 40

		// settle 後に返却が呼ばれても全額返却しない。
		await refundReservation(userId, requestId, 30);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("通常の返却は反映し、二重返却で二重加算しない(#146)", async () => {
		const requestId = `refund-${userId}`;
		await reserveCredits(userId, charge(30_000), requestId); // 50→20
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
		await reserveCredits(userId, charge(30_000), requestId); // 50→20
		await ageReservation(requestId, PAST_GRACE_MS);

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(1);
	});

	it("猶予内の予約は回収しない(実行中のリクエストを奪わない)", async () => {
		const requestId = `inflight-${userId}`;
		await reserveCredits(userId, charge(30_000), requestId);
		// created_at は現在時刻のまま(=まだ実行中とみなす)。

		await reclaimOrphanReservations(userId);

		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("確定済み(差分返却あり)の予約は回収しない", async () => {
		const requestId = `settled-${userId}`;
		await reserveCredits(userId, charge(30_000), requestId); // 50→20
		await settleReservation(userId, requestId, 30, charge(10_000)); // +20 → 40
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
		await reserveCredits(userId, charge(30_000), requestId); // 50→20
		await settleReservation(userId, requestId, 30, charge(30_000)); // 差分0
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
		await reserveCredits(userId, charge(30_000), requestId); // 50→20
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
			await reserveCredits(userId, charge(1_000), requestId); // 1クレジットずつ
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
		await reserveCredits(userId, charge(40_000), orphanId);
		await ageReservation(orphanId, PAST_GRACE_MS);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 40);

		const res = await reserveCredits(userId, charge(30_000), `next-${userId}`);

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
		await reserveCredits(userId, charge(30_000), requestId); // 50→20
		await refundReservation(userId, requestId, 30); // +30 → 50

		await settleReservation(userId, requestId, 30, charge(10_000));

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

// #335 の回帰。settle と refund の相互排他は「先に記録された方が勝つ」(docs/ai-credit-system.md)
// だが、その判定がバッチ**外**の事前 SELECT だけだと、確認〜コミットの間に相手側が
// コミットする窓が残る。10分超ハングしたリクエストの settle と、別リクエスト入口の
// 孤児回収(reclaim)の refund が、まさにこの窓で競合しうる。
//
// 窓は db.batch を1回だけ差し替えて再現する: 事前 SELECT を通過した後・バッチ実行の直前に
// 相手側の処理をコミットさせる。
describe("settle と refund の相互排他 (#335)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	/** 次の db.batch 実行の直前に競合処理を1度だけ割り込ませる。 */
	function commitBefore(competing: () => Promise<void>) {
		const realBatch = db.batch.bind(db);
		return vi.spyOn(db, "batch").mockImplementationOnce((async (
			statements: never,
		) => {
			await competing();
			return realBatch(statements);
			// biome-ignore lint/suspicious/noExplicitAny: spy の可変長シグネチャに合わせる
		}) as any);
	}

	it("事前SELECT通過後に返却がコミットしても、確定は残高を動かさない", async () => {
		const requestId = `race-settle-${userId}`;
		await reserveCredits(userId, charge(30_000), requestId); // 50 → 20

		// settle のバッチ直前に、孤児回収が予約全額(30)を返却してコミットする
		const spy = commitBefore(() => refundReservation(userId, requestId, 30));
		try {
			await settleReservation(userId, requestId, 30, charge(10_000));
		} finally {
			spy.mockRestore();
		}

		// 全額返却された状態のまま。差分(20)が上乗せされて消費がネットプラスにならない
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(1);
		// 負けた側は台帳にも何も書かない(残高と台帳の合計が食い違わない)
		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(0);
	});

	it("事前SELECT通過後に確定がコミットしても、返却は残高を動かさない", async () => {
		const requestId = `race-refund-${userId}`;
		await reserveCredits(userId, charge(30_000), requestId); // 50 → 20

		// refund のバッチ直前に、生き延びていたリクエストが確定してコミットする(差分 20 返却)
		const spy = commitBefore(() =>
			settleReservation(userId, requestId, 30, charge(10_000)),
		);
		try {
			await refundReservation(userId, requestId, 30);
		} finally {
			spy.mockRestore();
		}

		// 確定の差分だけが反映された状態のまま(予約全額の追加返却が起きない)
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);
		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(1);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});
});
