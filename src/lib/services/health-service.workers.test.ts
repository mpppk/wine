import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { EXPECTED_LATEST_MIGRATION } from "#/db/migrations";
import { checkHealth } from "./health-service";

// 実D1(miniflare)上でヘルスチェックを検証する(#336)。d1_migrations は wrangler /
// applyD1Migrations が作る運用テーブルで、drizzle のスキーマ管理外にあるため、
// 「実際に読めること」はモックでは担保できない。

describe("checkHealth", () => {
	it("適用済みマイグレーションを実D1から読み、コードの期待と一致する", async () => {
		const result = await checkHealth();

		expect(result.db).toBe("ok");
		// テスト用D1には drizzle/ 全件が適用済みなので、コード側の期待と一致するはず。
		// ここが落ちる = drizzle/ に連番を足して src/db/migrations.ts の更新を忘れている。
		expect(result.migration.applied).toBe(EXPECTED_LATEST_MIGRATION);
		expect(result.migration.inSync).toBe(true);
		expect(result.ok).toBe(true);
	});

	it("適用済み世代がコードの期待とズレていたら ok=false にする", async () => {
		// 「マイグレーションだけ当たって新 Worker が反映されていない」状態を再現する
		await env.DB.prepare(
			"INSERT INTO d1_migrations (name, applied_at) VALUES (?, CURRENT_TIMESTAMP)",
		)
			.bind("9999_future_migration.sql")
			.run();
		try {
			const result = await checkHealth();
			expect(result.migration.applied).toBe("9999_future_migration");
			expect(result.migration.inSync).toBe(false);
			expect(result.ok).toBe(false);
			// DB 自体は読めているので db は ok のまま(接続障害と区別する)
			expect(result.db).toBe("ok");
		} finally {
			await env.DB.prepare("DELETE FROM d1_migrations WHERE name = ?")
				.bind("9999_future_migration.sql")
				.run();
		}
	});

	it("D1 が読めないときは throw せず db=error を返す", async () => {
		const spy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
			throw new Error("D1_ERROR: network");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await checkHealth();
			expect(result).toEqual({
				ok: false,
				db: "error",
				migration: {
					applied: null,
					expected: EXPECTED_LATEST_MIGRATION,
					inSync: false,
				},
			});
		} finally {
			spy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});
