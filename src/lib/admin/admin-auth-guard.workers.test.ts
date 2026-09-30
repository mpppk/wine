import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { auth } from "#/lib/auth";
import { handleAuthRequest } from "./auth-ingress";
import { RAW_ADMIN_AUTH_ENDPOINTS } from "./blocked-auth-paths";

// 生 admin エンドポイントの回帰テスト(#543)を実D1上で検証する。
//
// 穴の構図: `src/routes/api/auth/$.ts` の catch-all が `/api/auth/admin/*` を
// 丸ごと `auth.handler` へ転送していたため、admin セッションがあれば set-role /
// set-user-password を fetch 1本で叩けて、監査ログにも理由必須にも載らなかった。
// 修正は HTTP 入口(`handleAuthRequest`)での拒否で、サーバ内の `auth.api.*`
// 直接呼び出し(監査付き正規経路)は HTTP を経由しないので通る。両側をここで固定する。

const BASE_URL = "http://localhost:3000";
const PASSWORD = "guard-regression-1234";

let seq = 0;
function freshEmail(prefix: string): string {
	seq += 1;
	return `${prefix}-${seq}@example.test`;
}

// テスト環境ではクライアントIPが解決できず、レートリミットがパスごとの単一共有
// バケットに落ちる。認証系を叩く前に毎回カウンタを空にする(既存テストと同型)。
async function guardedFetch(
	path: string,
	init: { method?: string; body?: unknown; cookie?: string },
): Promise<Response> {
	await env.DB.prepare("DELETE FROM rate_limit").run();
	return await handleAuthRequest(
		new Request(`${BASE_URL}${path}`, {
			method: init.method ?? "POST",
			headers: {
				"content-type": "application/json",
				origin: BASE_URL,
				...(init.cookie ? { cookie: init.cookie } : {}),
			},
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		}),
	);
}

async function createUser(email: string): Promise<string> {
	const res = await guardedFetch("/api/auth/sign-up/email", {
		body: { email, password: PASSWORD, name: email },
	});
	if (!res.ok) throw new Error(`sign-up failed: ${res.status}`);
	const id = ((await res.json()) as { user?: { id?: string } }).user?.id;
	if (!id) throw new Error("sign-up returned no user id");
	return id;
}

async function sessionCookie(email: string): Promise<string> {
	const res = await guardedFetch("/api/auth/sign-in/email", {
		body: { email, password: PASSWORD },
	});
	if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
	return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function roleOf(userId: string): Promise<string | null> {
	const rows = await db
		.select({ role: user.role })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return rows[0]?.role ?? null;
}

async function bannedOf(userId: string): Promise<boolean | null> {
	const rows = await db
		.select({ banned: user.banned })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return rows[0]?.banned ?? null;
}

let adminCookie = "";
let victimId = "";
let victimEmail = "";

beforeAll(async () => {
	const adminEmail = freshEmail("guard-admin");
	const adminId = await createUser(adminEmail);
	// 初回の admin 付与は本番でも手動 UPDATE。テストでも同じ形で昇格させる。
	await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?")
		.bind(adminId)
		.run();
	adminCookie = await sessionCookie(adminEmail);
	victimEmail = freshEmail("guard-victim");
	victimId = await createUser(victimEmail);
});

describe("生エンドポイント経由の昇格・乗っ取りは拒否される", () => {
	it("set-role が 403 になり、対象の role は変わらない", async () => {
		expect(await roleOf(victimId)).toBe("user");
		const res = await guardedFetch("/api/auth/admin/set-role", {
			cookie: adminCookie,
			body: { userId: victimId, role: "admin" },
		});
		expect(res.status).toBe(403);
		expect(await roleOf(victimId)).toBe("user");
	});

	it("set-user-password が 403 になり、旧パスワードでサインインできる", async () => {
		const res = await guardedFetch("/api/auth/admin/set-user-password", {
			cookie: adminCookie,
			body: { userId: victimId, newPassword: "hijacked-password-9999" },
		});
		expect(res.status).toBe(403);
		// 乗っ取られていないこと=旧パスワードが生きていることで確認する。
		const signIn = await guardedFetch("/api/auth/sign-in/email", {
			body: { email: victimEmail, password: PASSWORD },
		});
		expect(signIn.status).toBe(200);
	});

	it("列挙した危険操作がすべて同じ関門で拒否される", async () => {
		for (const endpoint of RAW_ADMIN_AUTH_ENDPOINTS) {
			const res = await guardedFetch(`/api/auth${endpoint}`, {
				cookie: adminCookie,
				body: {},
			});
			expect(res.status, endpoint).toBe(403);
		}
	});

	it("GET の参照系(remove 対象外の例: list-users)も拒否される", async () => {
		const res = await guardedFetch("/api/auth/admin/list-users", {
			method: "GET",
			cookie: adminCookie,
		});
		expect(res.status).toBe(403);
	});
});

describe("正規経路は従来どおり動く", () => {
	it("sign-up / sign-in が関門を素通りする", async () => {
		const email = freshEmail("guard-legit");
		expect(await createUser(email)).not.toBe("");
		expect(await sessionCookie(email)).not.toBe("");
	});

	it("サーバ内の auth.api 直接呼び出し(ban/unban)は塞がれない", async () => {
		const headers = new Headers({ cookie: adminCookie });
		// HTTP 入口を経由しない内部呼び出しなので、関門の影響を受けない。
		await auth.api.banUser({
			body: { userId: victimId, banReason: "guard regression test" },
			headers,
		});
		expect(await bannedOf(victimId)).toBe(true);
		await auth.api.unbanUser({ body: { userId: victimId }, headers });
		expect(await bannedOf(victimId)).toBe(false);
	});
});
