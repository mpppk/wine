import { describe, expect, it } from "vitest";
import { bannedResponse, MCP_BANNED_MESSAGE } from "./ban-guard";

describe("bannedResponse", () => {
	it("再認可を促さない 403 を返す", async () => {
		const res = bannedResponse();
		expect(res.status).toBe(403);
		// 401 + WWW-Authenticate だとクライアントが再認可を試みるが、BAN 中は
		// サインイン自体が拒否されるため成功しえない(#330)。
		expect(res.headers.get("www-authenticate")).toBeNull();
	});

	it("ホストが理由を読める JSON-RPC エラー本文を返す", async () => {
		const body = (await bannedResponse().json()) as {
			jsonrpc: string;
			error: { code: number; message: string };
			id: null;
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.error.message).toBe(MCP_BANNED_MESSAGE);
		expect(body.id).toBeNull();
	});
});
