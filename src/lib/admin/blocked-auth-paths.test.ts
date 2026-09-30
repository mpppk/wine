import { describe, expect, it } from "vitest";
import {
	blockedAdminAuthResponse,
	isBlockedAdminAuthPath,
	RAW_ADMIN_AUTH_ENDPOINTS,
} from "./blocked-auth-paths";

// 生 admin エンドポイントの関門(#543)。判定は `blocked-auth-paths.ts` の1関数に
// 寄せているので、ここでは「列挙した危険操作がすべて塞がれること」と「正規の
// 認証経路が塞がれないこと」を固定する。better-auth のバージョンで surface が
// 変わりうるため、列挙の正は routes.mjs と照合すること(モジュールのコメント参照)。

const BASE = "http://localhost:3000";

describe("isBlockedAdminAuthPath", () => {
	it("列挙した危険操作をすべて塞ぐ", () => {
		// 実害のある操作が1つでも関門を素通りしたら即バグなので、個別ではなく列挙で回す。
		for (const endpoint of RAW_ADMIN_AUTH_ENDPOINTS) {
			expect(isBlockedAdminAuthPath(endpoint), endpoint).toBe(true);
		}
	});

	it("将来の admin 配下エンドポイントも既定で塞ぐ", () => {
		expect(isBlockedAdminAuthPath("/admin/some-future-endpoint")).toBe(true);
		expect(isBlockedAdminAuthPath("/admin")).toBe(true);
	});

	it("正規の認証経路は塞がない", () => {
		for (const path of [
			"/sign-in/email",
			"/sign-up/email",
			"/sign-out",
			"/get-session",
			"/update-user",
			"/delete-user",
			"/stripe/webhook",
		]) {
			expect(isBlockedAdminAuthPath(path), path).toBe(false);
		}
	});

	it("似た接頭辞の非 admin パスを塞がない", () => {
		expect(isBlockedAdminAuthPath("/administrator")).toBe(false);
	});
});

describe("blockedAdminAuthResponse", () => {
	it("生エンドポイント宛ては 403 を返す", () => {
		for (const endpoint of RAW_ADMIN_AUTH_ENDPOINTS) {
			const res = blockedAdminAuthResponse(
				new Request(`${BASE}/api/auth${endpoint}`, { method: "POST" }),
			);
			expect(res?.status, endpoint).toBe(403);
		}
	});

	it("正規経路は null(転送継続)を返す", () => {
		expect(
			blockedAdminAuthResponse(
				new Request(`${BASE}/api/auth/sign-in/email`, { method: "POST" }),
			),
		).toBeNull();
		expect(
			blockedAdminAuthResponse(
				new Request(`${BASE}/api/auth/stripe/webhook`, { method: "POST" }),
			),
		).toBeNull();
	});
});
