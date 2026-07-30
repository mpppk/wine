import { env } from "cloudflare:workers";
import { EXPECTED_LATEST_MIGRATION } from "#/db/migrations";
import { logError } from "#/lib/logger";

// 未認証で叩けるヘルスチェックの中身(#336)。
//
// スモーク(scripts/smoke.sh, 6時間ごと)の他のチェックは、いずれも D1 に到達しない:
// `/` は session ガードで Cookie 無しなら DB を引かず、better-auth の ok/get-session は
// DB クエリ前に返り、`/api/mcp` はトークン不在で 401、`.well-known` と GeoJSON は静的。
// つまり「マイグレーションだけ当たって新 Worker が反映されていない」「D1 バインディングの
// 設定ミス」のような、このリポジトリで最も警戒している障害クラス(CLAUDE.md のスキーマ変更節)
// を、スモークが 1 つも検出できなかった。ここが唯一の D1 到達点になる。

export interface HealthResult {
	ok: boolean;
	db: "ok" | "error";
	migration: {
		/** D1 に実際に適用済みの最新マイグレーション(未取得なら null)。 */
		applied: string | null;
		/** このコードが前提とする世代。 */
		expected: string;
		/** 両者が一致しているか。false = 「新スキーマ×旧コード」等のズレ。 */
		inSync: boolean;
	};
}

/** wrangler が適用済みマイグレーションを記録するテーブル(drizzle のスキーマ管理外)。 */
async function latestAppliedMigration(): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
	).first<{ name: string }>();
	// 記録は "0020_foo.sql" 形式。比較しやすいよう拡張子を落とす。
	return row?.name.replace(/\.sql$/, "") ?? null;
}

/**
 * D1 への到達性と、適用済みスキーマ世代の一致を確認する。
 *
 * 例外は投げず、失敗も結果として返す(ヘルスチェックが 500 で落ちると「アプリが死んでいる」
 * のか「ヘルスチェックが壊れている」のか区別できないため)。
 */
export async function checkHealth(): Promise<HealthResult> {
	let applied: string | null;
	try {
		applied = await latestAppliedMigration();
	} catch (err) {
		logError("health check failed to read d1", { err });
		return {
			ok: false,
			db: "error",
			migration: {
				applied: null,
				expected: EXPECTED_LATEST_MIGRATION,
				inSync: false,
			},
		};
	}
	const inSync = applied === EXPECTED_LATEST_MIGRATION;
	return {
		ok: inSync,
		db: "ok",
		migration: { applied, expected: EXPECTED_LATEST_MIGRATION, inSync },
	};
}
