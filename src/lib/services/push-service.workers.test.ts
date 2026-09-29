import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { pushSubscription } from "#/db/schema";
import {
	decodeJwtClaims,
	importVapidPublicKey,
	parseVapidAuthorization,
	verifyJwtSignature,
} from "#/lib/push/vapid";
import {
	deletePushSubscription,
	hasPushSubscription,
	isWebPushConfigured,
	MAX_PUSH_SUBSCRIPTIONS_PER_USER,
	PUSH_FETCH_TIMEOUT_MS,
	savePushSubscription,
	sendPushToUser,
	webPushPublicKey,
} from "./push-service";

// Web Push の購読管理と送信を実D1で検証する(Issue #466)。
//
// **実配信はこの環境では確認できない**(ヘッドレス Chromium がプッシュ購読を作れない)。
// そこで自動テストで固めるのは、配信の可否によらず正しさが決まる部分:
//  - 購読の CRUD と、同じ端末の再購読が重複しないこと
//  - プッシュサービスの応答に対する扱い(無効なら消す / 一時障害なら残す)
//  - 鍵が無い環境で機能ごと無効になること
//  - リクエストが本文なしで組み上がり、**VAPID の署名が検証できる**こと
//
// 本文の暗号化を捨てた(#466)ので、残る暗号処理は VAPID だけ。そちらは自分で検証
// できるため、「実際に届くか」を見なくても正しさが閉じる。

/** 実在の形式を持つ VAPID 鍵ペア(このテスト専用に生成したもの)。 */
const TEST_VAPID_PUBLIC =
	"BDE48t-TAG4btM4wIJqbb9ooz-n4VjJXAF8IjNoCoTzlYWtF7l9rAIq57GceUM2aWL98Ckq6PaVo2TXJDSZJMPU"; // gitleaks:allow(テスト専用の生成キー)

/** ブラウザが返す形の購読鍵(P-256 の生の公開鍵と16バイトの共有秘密)。 */
const SUB = {
	endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
	p256dh:
		"BDW6GYofjHUah10yVVsE46Kuv8ymEDTKdmCWbbx8fuCU44iszSq_WZ4ssHAc0zmdXC_4izIpe3d4fbtZufD624U",
	auth: "_uUrYO9c6_VfLfLJD7KRQg", // gitleaks:allow(テスト専用の購読鍵)
};

/** テスト用の VAPID 秘密鍵(pkcs8/base64url)。公開鍵 TEST_VAPID_PUBLIC と対。 */
const TEST_VAPID_PRIVATE =
	"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgKJM-c2C7YuOPa4LE6Zx-95oQVz-kIEdHrZI8OL5l1KmhRANCAAQxOPLfkwBuG7TOMCCam2_aKM_p-FYyVwBfCIzaAqE85WFrRe5fawCKuexnHlDNmli_fApKuj2laNk1yQ0mSTD1";

async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "push-user", `${id}@example.test`)
		.run();
	return id;
}

function setVapid(privateKey: string | undefined): void {
	const e = env as unknown as {
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
	};
	e.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
	if (privateKey === undefined) {
		e.VAPID_PRIVATE_KEY = undefined;
	} else {
		e.VAPID_PRIVATE_KEY = privateKey;
	}
}

async function subsOf(userId: string) {
	return db
		.select()
		.from(pushSubscription)
		.where(eq(pushSubscription.userId, userId));
}

afterEach(() => {
	const e = env as unknown as Record<string, unknown>;
	e.VAPID_PUBLIC_KEY = undefined;
	e.VAPID_PRIVATE_KEY = undefined;
	vi.unstubAllGlobals();
});

describe("購読の管理", () => {
	it("購読を保存し、同じ端末の再購読では増えない", async () => {
		const userId = await seedUser();

		await savePushSubscription(userId, SUB, "Mozilla/5.0 test");
		// 同じブラウザで再購読すると同じ endpoint が返る。行が増えると同じ端末へ2通送る。
		await savePushSubscription(userId, { ...SUB, auth: "dXBkYXRlZA" });

		const rows = await subsOf(userId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.auth).toBe("dXBkYXRlZA");
		expect(rows[0]?.userAgent).toBe("Mozilla/5.0 test");
		expect(await hasPushSubscription(userId)).toBe(true);
	});

	it("同じ端末で別アカウントにログインし直すと持ち主が移る", async () => {
		const first = await seedUser();
		const second = await seedUser();
		await savePushSubscription(first, SUB);

		await savePushSubscription(second, SUB);

		// 通知の宛先は新しいユーザであるべき(古い持ち主に他人の完了通知が飛ばない)。
		expect(await subsOf(first)).toHaveLength(0);
		expect(await subsOf(second)).toHaveLength(1);
	});

	it("解除は本人のものだけ消す", async () => {
		const owner = await seedUser();
		const other = await seedUser();
		await savePushSubscription(owner, SUB);

		await deletePushSubscription(other, SUB.endpoint);
		expect(await subsOf(owner)).toHaveLength(1);

		await deletePushSubscription(owner, SUB.endpoint);
		expect(await subsOf(owner)).toHaveLength(0);
	});

	it("存在しない endpoint の解除は成功扱い(冪等)", async () => {
		const userId = await seedUser();
		await expect(
			deletePushSubscription(userId, "https://example.test/none"),
		).resolves.toBeUndefined();
	});
});

describe("鍵が無い環境", () => {
	it("機能ごと無効になり、送信もしない", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid(undefined);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		expect(isWebPushConfigured()).toBe(false);
		expect(webPushPublicKey()).toBeNull();
		expect(await sendPushToUser(userId)).toBe(0);
		// 購読があっても送りにいかない(UI も出さないので、そもそも購読は増えない)。
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("送信", () => {
	it("本文なしのリクエストを購読の endpoint へ送り、署名が検証できる", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid(TEST_VAPID_PRIVATE);
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(null, { status: 201 });
		});

		const sent = await sendPushToUser(userId);

		expect(sent).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(SUB.endpoint);
		const headers = calls[0]?.init.headers as Record<string, string>;
		// **本文を送らない**(#466)。送るものが無いので暗号化も要らない。
		expect(calls[0]?.init.body).toBeUndefined();
		expect(headers["Content-Length"]).toBe("0");
		// 暗号化まわりのヘッダは出ない(本文が無いので付ける意味も無い)。
		expect(headers["Content-Encoding"]).toBeUndefined();
		expect(headers.Encryption).toBeUndefined();
		expect(headers.TTL).toBe(String(12 * 60 * 60));

		// **残る暗号処理は VAPID だけで、それは検証できる**。ここが payload-less に
		// した見返り——「届くか」を見なくても署名の正しさが閉じる。
		const parsed = parseVapidAuthorization(headers.Authorization ?? "");
		expect(parsed?.publicKey).toBe(TEST_VAPID_PUBLIC);
		const publicKey = await importVapidPublicKey(TEST_VAPID_PUBLIC);
		expect(await verifyJwtSignature(parsed?.jwt ?? "", publicKey)).toBe(true);
		// aud は endpoint のオリジン(購読ごとに署名し直している証拠)
		expect(decodeJwtClaims(parsed?.jwt ?? "")?.aud).toBe(
			"https://fcm.googleapis.com",
		);

		// 成功したら最終送信時刻を残す(送れていない購読の棚卸しに使う)。
		expect((await subsOf(userId))[0]?.lastNotifiedAt).not.toBeNull();
	});

	it("購読ごとに aud を変えて署名する", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		await savePushSubscription(userId, {
			...SUB,
			endpoint: "https://updates.push.services.mozilla.com/wpush/v2/xyz",
		});
		setVapid(TEST_VAPID_PRIVATE);
		const auds: unknown[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const headers = init.headers as Record<string, string>;
			const parsed = parseVapidAuthorization(headers.Authorization ?? "");
			auds.push(decodeJwtClaims(parsed?.jwt ?? "")?.aud);
			return new Response(null, { status: 201 });
		});

		expect(await sendPushToUser(userId)).toBe(2);
		// 使い回すとプッシュサービスに弾かれる(aud が自分自身かを見るため)。
		expect(auds.sort()).toEqual([
			"https://fcm.googleapis.com",
			"https://updates.push.services.mozilla.com",
		]);
	});

	it("410 が返った購読は消す", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid(TEST_VAPID_PRIVATE);
		vi.stubGlobal("fetch", async () => new Response(null, { status: 410 }));

		expect(await sendPushToUser(userId)).toBe(0);
		expect(await subsOf(userId)).toHaveLength(0);
	});

	it("一時的な失敗では購読を消さない", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid(TEST_VAPID_PRIVATE);
		vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));

		expect(await sendPushToUser(userId)).toBe(0);
		// プッシュサービスの一時障害で全ユーザの購読が飛ぶことを防ぐ。
		expect(await subsOf(userId)).toHaveLength(1);
	});

	it("送信が throw しても呼び出し元に伝播しない", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid(TEST_VAPID_PRIVATE);
		vi.stubGlobal("fetch", async () => {
			throw new Error("network down");
		});

		// 通知は付随物。ここで throw するとジョブの終端化を巻き込む。
		await expect(sendPushToUser(userId)).resolves.toBe(0);
		expect(await subsOf(userId)).toHaveLength(1);
	});

	it("購読が無ければ送信を試みない", async () => {
		const userId = await seedUser();
		setVapid(TEST_VAPID_PRIVATE);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		expect(await sendPushToUser(userId)).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("鍵が壊れていても throw しない", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid("not-a-valid-pkcs8-key");
		vi.stubGlobal("fetch", async () => new Response(null, { status: 201 }));

		expect(await sendPushToUser(userId)).toBe(0);
	});

	it("ガード強化前に登録された内部向け endpoint には送らず消す(#545)", async () => {
		const userId = await seedUser();
		// 受け取り口の検証を通らない旧行を直接保存した想定
		await savePushSubscription(userId, {
			...SUB,
			endpoint: "https://127.0.0.1/push",
		});
		setVapid(TEST_VAPID_PRIVATE);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		expect(await sendPushToUser(userId)).toBe(0);
		// 署名付きリクエスト自体を飛ばさない
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await subsOf(userId)).toHaveLength(0);
	});
});

describe("購読の上限(#634)", () => {
	it("6件目の登録で古いものから置換される", async () => {
		const userId = await seedUser();
		// createdAt をずらして直接置く(同時刻登録の順序不定を避ける)
		const base = Date.now() - 60_000;
		for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER; i++) {
			await db.insert(pushSubscription).values({
				id: crypto.randomUUID(),
				userId,
				endpoint: `https://fcm.googleapis.com/fcm/send/old-${i}`,
				p256dh: SUB.p256dh,
				auth: SUB.auth,
				createdAt: new Date(base + i * 1000),
			});
		}

		await savePushSubscription(userId, {
			...SUB,
			endpoint: "https://fcm.googleapis.com/fcm/send/new",
		});

		const rows = await subsOf(userId);
		expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
		const endpoints = rows.map((row) => row.endpoint);
		expect(endpoints).toContain("https://fcm.googleapis.com/fcm/send/new");
		expect(endpoints).not.toContain(
			"https://fcm.googleapis.com/fcm/send/old-0",
		);
		expect(endpoints).toContain("https://fcm.googleapis.com/fcm/send/old-4");
	});

	it("サービス経由の連続登録でも上限に頭打ちになり、新しい登録は残る", async () => {
		const userId = await seedUser();
		for (let i = 0; i <= MAX_PUSH_SUBSCRIPTIONS_PER_USER; i++) {
			await savePushSubscription(userId, {
				...SUB,
				endpoint: `https://fcm.googleapis.com/fcm/send/s-${i}`,
			});
		}

		const rows = await subsOf(userId);
		expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
		// 今回保存した endpoint は追い出しの対象外
		expect(rows.map((row) => row.endpoint)).toContain(
			`https://fcm.googleapis.com/fcm/send/s-${MAX_PUSH_SUBSCRIPTIONS_PER_USER}`,
		);
	});

	it("同じ endpoint の再購読では追い出しが起きない", async () => {
		const userId = await seedUser();
		const endpoints = Array.from(
			{ length: MAX_PUSH_SUBSCRIPTIONS_PER_USER },
			(_, i) => `https://fcm.googleapis.com/fcm/send/r-${i}`,
		);
		for (const endpoint of endpoints) {
			await savePushSubscription(userId, { ...SUB, endpoint });
		}

		// 件数は増えない上書き。再購読を理由に他が消えてはならない
		const firstEndpoint = endpoints[0];
		if (!firstEndpoint) throw new Error("unreachable");
		await savePushSubscription(userId, {
			...SUB,
			endpoint: firstEndpoint,
			auth: "dXBkYXRlZA",
		});

		const rows = await subsOf(userId);
		expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
		expect(rows.map((row) => row.endpoint).sort()).toEqual(
			[...endpoints].sort(),
		);
	});

	it("所有者の移転でも上限を守り、移転した購読は残る", async () => {
		const first = await seedUser();
		const second = await seedUser();
		const moved = "https://fcm.googleapis.com/fcm/send/moved";
		await savePushSubscription(first, { ...SUB, endpoint: moved });
		for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER; i++) {
			await savePushSubscription(second, {
				...SUB,
				endpoint: `https://fcm.googleapis.com/fcm/send/b-${i}`,
			});
		}

		await savePushSubscription(second, { ...SUB, endpoint: moved });

		expect(await subsOf(first)).toHaveLength(0);
		const rows = await subsOf(second);
		expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
		expect(rows.map((row) => row.endpoint)).toContain(moved);
	});
});

describe("送信の制限(#634)", () => {
	it("許可リスト外の endpoint には送らず消す", async () => {
		const userId = await seedUser();
		// SSRF ガードは通るがプッシュサービスではない旧行を直接保存した想定
		await savePushSubscription(userId, {
			...SUB,
			endpoint: "https://example.com/push",
		});
		setVapid(TEST_VAPID_PRIVATE);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		expect(await sendPushToUser(userId)).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await subsOf(userId)).toHaveLength(0);
	});

	it("送信fetchにタイムアウト信号を付ける", async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid(TEST_VAPID_PRIVATE);
		const signals: unknown[] = [];
		vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
			signals.push(init?.signal);
			return new Response(null, { status: 201 });
		});

		expect(await sendPushToUser(userId)).toBe(1);
		expect(signals).toHaveLength(1);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
	});

	it("応答の無い endpoint でもタイムアウトで終端化する", {
		timeout: 20_000,
	}, async () => {
		const userId = await seedUser();
		await savePushSubscription(userId, SUB);
		setVapid(TEST_VAPID_PRIVATE);
		vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
			// 実fetch同様、signal の中断でのみ失敗させる(中断されなければ永遠に止まる)
			await new Promise<void>((_resolve, reject) => {
				const signal = init?.signal;
				if (!(signal instanceof AbortSignal)) {
					reject(new Error("タイムアウト信号が付いていない"));
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
			throw new Error("到達しない");
		});

		const startedAt = Date.now();
		expect(await sendPushToUser(userId)).toBe(0);
		const elapsed = Date.now() - startedAt;
		// タイムアウトで打ち切られる(無制限に待たないことの固定)
		expect(elapsed).toBeGreaterThanOrEqual(PUSH_FETCH_TIMEOUT_MS - 1000);
		expect(elapsed).toBeLessThan(PUSH_FETCH_TIMEOUT_MS + 10_000);
		// 一時的な失敗なので購読は消さない
		expect(await subsOf(userId)).toHaveLength(1);
	});
});
