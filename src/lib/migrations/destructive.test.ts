import { describe, expect, it } from "vitest";
import {
	checkSql,
	errorsOf,
	hasAllowDestructiveMarker,
	splitStatements,
} from "./destructive";

// マイグレーション静的検査の回帰テスト(#264)。ここが緩むと、破壊的変更や非冪等な SQL が
// CI をすり抜けて共有プレビューDB(#54)や本番(#24)に届く。

const messages = (sql: string, opts?: { allowDestructive?: boolean }) =>
	checkSql(sql, opts).map((f) => `${f.level}: ${f.message}`);
const errorMessages = (sql: string, opts?: { allowDestructive?: boolean }) =>
	errorsOf(checkSql(sql, opts)).map((f) => f.message);

describe("splitStatements", () => {
	it("statement-breakpoint で分割する(コメント除去より前に分ける)", () => {
		// drizzle が生成する形。`;` を書かないので、breakpoint が消えると1文に結合される。
		const sql = [
			"CREATE TABLE IF NOT EXISTS a (id text)",
			"--> statement-breakpoint",
			"CREATE INDEX idx_a ON a (id)",
		].join("\n");
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[1]).toContain("CREATE INDEX");
	});

	it("結合されないので、隣の文の IF NOT EXISTS を自分のものと誤認しない", () => {
		const sql = [
			"CREATE TABLE IF NOT EXISTS a (id text)",
			"--> statement-breakpoint",
			"CREATE INDEX idx_a ON a (id)",
		].join("\n");
		expect(errorMessages(sql)).toEqual([
			expect.stringContaining("CREATE INDEX に IF NOT EXISTS がありません"),
		]);
	});

	it("`;` 区切りとコメントも従来どおり扱う", () => {
		const sql = `
-- 先頭コメント
CREATE TABLE IF NOT EXISTS a (id text); /* ブロック */
DROP INDEX IF EXISTS idx_a;
`;
		expect(splitStatements(sql)).toHaveLength(2);
		expect(errorMessages(sql)).toEqual([]);
	});
});

describe("破壊的な変更の検出", () => {
	it("DROP TABLE を検出する", () => {
		expect(errorMessages("DROP TABLE IF EXISTS wine;")).toEqual([
			expect.stringContaining("DROP TABLE は破壊的です"),
		]);
	});

	it("DROP COLUMN を検出する", () => {
		expect(errorMessages("ALTER TABLE wine DROP COLUMN memo;")).toEqual([
			expect.stringContaining("カラム削除"),
		]);
	});

	it("COLUMN を省略した DROP も検出する(SQLite の省略構文)", () => {
		// `DROP COLUMN` 決め打ちの正規表現ではここが素通りしていた。
		expect(errorMessages("ALTER TABLE wine DROP memo;")).toEqual([
			expect.stringContaining("カラム削除"),
		]);
	});

	it("RENAME を検出する", () => {
		expect(errorMessages("ALTER TABLE wine RENAME TO wine_old;")).toEqual([
			expect.stringContaining("RENAME は破壊的です"),
		]);
		expect(
			errorMessages("ALTER TABLE wine RENAME COLUMN memo TO note;"),
		).toEqual([expect.stringContaining("RENAME は破壊的です")]);
	});

	it("NOT NULL の追加を検出する", () => {
		// 旧コードの INSERT が落ちるため expand-and-contract の対象(CLAUDE.md)。
		expect(
			errorMessages(
				"ALTER TABLE wine ADD COLUMN status text NOT NULL DEFAULT 'owned';",
			),
		).toEqual([expect.stringContaining("NOT NULL の追加は破壊的です")]);
	});

	it("NULL 許容のカラム追加は破壊的ではない", () => {
		expect(errorMessages("ALTER TABLE wine ADD COLUMN memo text;")).toEqual([]);
	});

	it("allow-destructive-migration マーカーで破壊的判定だけ抑止する", () => {
		const sql = `-- allow-destructive-migration
ALTER TABLE wine DROP memo;
CREATE INDEX idx_wine ON wine (id);`;
		expect(hasAllowDestructiveMarker(sql)).toBe(true);
		const errs = errorMessages(sql, { allowDestructive: true });
		// 破壊的判定は消えるが、冪等性チェックは残る
		expect(errs).toEqual([
			expect.stringContaining("CREATE INDEX に IF NOT EXISTS がありません"),
		]);
	});
});

describe("冪等性", () => {
	it("CREATE TABLE / CREATE INDEX / DROP TABLE / DROP INDEX のガード漏れを検出する", () => {
		expect(errorMessages("CREATE TABLE wine (id text);")).toEqual([
			expect.stringContaining("CREATE TABLE に IF NOT EXISTS がありません"),
		]);
		expect(errorMessages("CREATE UNIQUE INDEX u ON wine (id);")).toEqual([
			expect.stringContaining("CREATE INDEX に IF NOT EXISTS がありません"),
		]);
		expect(errorMessages("DROP INDEX idx_wine;")).toEqual([
			expect.stringContaining("DROP INDEX に IF EXISTS がありません"),
		]);
	});

	it("ADD COLUMN は警告する(SQLite に IF NOT EXISTS が無い)が CI は落とさない", () => {
		const sql = "ALTER TABLE wine ADD COLUMN memo text;";
		expect(messages(sql)).toEqual([
			expect.stringContaining("warn: ADD COLUMN は冪等にできません"),
		]);
		expect(errorMessages(sql)).toEqual([]);
	});

	it("DROP は ADD COLUMN の警告を出さない(誤検出しない)", () => {
		const findings = checkSql("ALTER TABLE wine DROP memo;");
		expect(findings.filter((f) => f.level === "warn")).toEqual([]);
	});
});

describe("既存のマイグレーション運用と矛盾しないこと", () => {
	it("冪等に書かれた通常の追加マイグレーションは error を出さない", () => {
		const sql = `CREATE TABLE IF NOT EXISTS coupon_redemption (
			id text PRIMARY KEY NOT NULL,
			user_id text NOT NULL
		);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemption_user_code_uq ON coupon_redemption (user_id, code);`;
		expect(errorMessages(sql)).toEqual([]);
	});
});
