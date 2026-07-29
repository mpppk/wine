import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { account, session, user, verification } from "./auth-schema";

// auth-schema.ts(Drizzle の実行時クエリ層)と手書きの連番SQLの突合(#272)。
//
// この repo は drizzle-kit を使わず、SQL は手書きで積む(docs/architecture.md)。
// つまり「schema.ts と SQL が一致していること」を保証する仕組みが無く、実際
// account.updated_at だけ SQL に DEFAULT があって schema.ts に無い、という乖離が
// 残っていた。実害は出ていなかった(better-auth のアダプタが insert 時に値を渡す)が、
// 突合の基準が無いと次のズレも同じように気づかれない。
//
// 列の網羅ではなく、**DEFAULT の有無**という食い違いやすい1点に絞って固定する。

const SQL = readFileSync(
	join(process.cwd(), "drizzle/0002_better_auth_schema.sql"),
	"utf8",
);

/** 0002 の CREATE TABLE から、その列に DEFAULT 句があるかを読む */
function sqlColumnHasDefault(table: string, column: string): boolean {
	const body = SQL.match(
		new RegExp(
			`CREATE TABLE IF NOT EXISTS \`${table}\` \\(([\\s\\S]*?)\\n\\);`,
		),
	)?.[1];
	if (!body) throw new Error(`CREATE TABLE ${table} が 0002 に見つかりません`);
	const line = body
		.split("\n")
		.find((l) => l.trim().startsWith(`\`${column}\``));
	if (!line) throw new Error(`${table}.${column} が 0002 に見つかりません`);
	return /\bDEFAULT\b/i.test(line);
}

const TABLES = [
	{ name: "user", table: user },
	{ name: "session", table: session },
	{ name: "account", table: account },
	{ name: "verification", table: verification },
] as const;

describe("auth-schema と drizzle/0002 の DEFAULT が一致する (#272)", () => {
	for (const { name, table } of TABLES) {
		for (const column of ["created_at", "updated_at"] as const) {
			it(`${name}.${column}`, () => {
				const columns = getTableColumns(table) as Record<
					string,
					{ name: string; default?: unknown }
				>;
				const col = Object.values(columns).find((c) => c.name === column);
				expect(col, `${name}.${column} が auth-schema に無い`).toBeDefined();
				// `hasDefault` は $onUpdate() でも真になるため使えない(session.updated_at が
				// まさにそれ)。SQL の DEFAULT 句に対応するのは `default` の有無。
				expect(col?.default !== undefined).toBe(
					sqlColumnHasDefault(name, column),
				);
			});
		}
	}
});
