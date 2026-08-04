import { describe, expect, it } from "vitest";
import { db } from "#/db";
import { oauthApplication } from "#/db/auth-schema";
import { getOAuthClientSummary } from "./oauth-client-service";

// 同意画面に出すクライアント情報の取得(#399)を実D1で検証する。
// **表示する値は攻撃者が自由に登録できる**前提なので、ここでは「何を出すか」より
// 「何を出さないか」と「壊れた入力で表示を汚されないか」を固定する。

let seq = 0;
async function registerClient(overrides: {
	name?: string;
	redirectUrls: string;
	disabled?: boolean;
}): Promise<string> {
	seq += 1;
	const clientId = `client-${seq}`;
	await db.insert(oauthApplication).values({
		id: `app-${seq}`,
		name: overrides.name ?? "Test Client",
		clientId,
		clientSecret: "super-secret-value",
		redirectUrls: overrides.redirectUrls,
		type: "web",
		disabled: overrides.disabled ?? false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return clientId;
}

describe("getOAuthClientSummary", () => {
	it("登録済みクライアントの名前と送り先ホストを返す", async () => {
		const clientId = await registerClient({
			name: "Claude Desktop",
			redirectUrls: "https://claude.ai/api/mcp/auth_callback",
		});

		const summary = await getOAuthClientSummary(clientId);

		expect(summary).toEqual({
			name: "Claude Desktop",
			redirectHosts: ["claude.ai"],
			registeredAt: expect.any(Number),
		});
	});

	// クライアントシークレットは同意の判断に不要。境界の外に出さない。
	it("クライアントシークレットを返さない", async () => {
		const clientId = await registerClient({
			redirectUrls: "https://example.test/cb",
		});

		const summary = await getOAuthClientSummary(clientId);

		expect(JSON.stringify(summary)).not.toContain("super-secret-value");
		expect(Object.keys(summary ?? {}).sort()).toEqual([
			"name",
			"redirectHosts",
			"registeredAt",
		]);
	});

	// URL 全体ではなくホストを出す(長いURLはパスに紛れて誤読を誘う)。
	// 複数登録・重複はまとめる。
	it("複数の redirect_uri はホストで重複排除する", async () => {
		const clientId = await registerClient({
			redirectUrls: "https://a.test/cb,https://a.test/other,https://b.test/cb",
		});

		const summary = await getOAuthClientSummary(clientId);

		expect(summary?.redirectHosts).toEqual(["a.test", "b.test"]);
	});

	// 攻撃者は redirect_uri に任意の文字列を登録できる。URL として解釈できない値を
	// そのまま出すと、表示を汚して他の項目を偽装される余地ができる。
	it("URL として解釈できない値は落とす", async () => {
		const clientId = await registerClient({
			redirectUrls: "not a url,https://ok.test/cb,   ",
		});

		const summary = await getOAuthClientSummary(clientId);

		expect(summary?.redirectHosts).toEqual(["ok.test"]);
	});

	it("名前が空白だけなら null にする(空欄として表示側で扱う)", async () => {
		const clientId = await registerClient({
			name: "   ",
			redirectUrls: "https://ok.test/cb",
		});

		expect((await getOAuthClientSummary(clientId))?.name).toBeNull();
	});

	it("未登録の client_id は null", async () => {
		expect(await getOAuthClientSummary("no-such-client")).toBeNull();
	});

	// 無効化されたクライアントの情報を出すと、失効済みの登録が有効に見える。
	it("無効化済みクライアントは null", async () => {
		const clientId = await registerClient({
			redirectUrls: "https://ok.test/cb",
			disabled: true,
		});

		expect(await getOAuthClientSummary(clientId)).toBeNull();
	});
});
