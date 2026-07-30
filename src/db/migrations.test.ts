import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_LATEST_MIGRATION } from "./migrations";

// EXPECTED_LATEST_MIGRATION は手書きの定数なので、drizzle/ の実体とズレると
// ヘルスチェック(/api/health)が常に不健全を報告する(または本物のズレを見逃す)。
// 連番SQLを足したら必ず更新する、を機械的に強制する(#336)。

function migrationFiles(): string[] {
	const dir = path.resolve(process.cwd(), "drizzle");
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
}

describe("EXPECTED_LATEST_MIGRATION", () => {
	it("drizzle/ の最新の連番SQLと一致する", () => {
		const files = migrationFiles();
		const latest = files.at(-1)?.replace(/\.sql$/, "");
		expect(
			EXPECTED_LATEST_MIGRATION,
			`drizzle/ に連番を足したら src/db/migrations.ts の EXPECTED_LATEST_MIGRATION も ${latest} に更新する`,
		).toBe(latest);
	});

	it("連番に欠番・重複が無い", () => {
		// 最新の判定を単純な辞書順ソートに任せているので、番号が連続していることを前提にする。
		const numbers = migrationFiles().map((f) => Number(f.slice(0, 4)));
		expect(numbers).toEqual(numbers.map((_, i) => i));
	});
});
