// 手書きマイグレーション(drizzle/*.sql)の静的検査。DB にも `cloudflare:workers` にも
// 依存しない純ロジックなので、単体テスト(jsdom プロジェクト)で挙動を固定できる。
// CI から呼ぶ入口は scripts/check-destructive-migrations.mjs(#137 / #264)。
//
// 検査するのは運用ルール2本:
//  - 破壊的なスキーマ変更(DROP・RENAME・NOT NULL 追加)は expand-and-contract で2段階に分ける(#24)
//  - マイグレーションは冪等に書く(CREATE ... IF NOT EXISTS / DROP ... IF EXISTS)(#54)

/** 検査結果1件。error は CI を落とし、warn は表示のみ(判断材料)。 */
export interface MigrationFinding {
	level: "error" | "warn";
	message: string;
}

/** 意図的に破壊的変更を通すためのマーカー(参照コードの削除を先行デプロイ済みの場合など)。 */
export const ALLOW_DESTRUCTIVE_MARKER = "allow-destructive-migration";

export function hasAllowDestructiveMarker(sql: string): boolean {
	return new RegExp(`--\\s*${ALLOW_DESTRUCTIVE_MARKER}`, "i").test(sql);
}

/** SQLから行コメント(-- ...)とブロックコメント(/* ... *\/)を除去する。 */
function stripComments(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * SQL本文を文単位に分割する(`;` と drizzle の statement-breakpoint 双方に対応)。
 *
 * **breakpoint の分割はコメント除去より前に行う**。`--> statement-breakpoint` は `--` で
 * 始まる行コメントなので、先に stripComments を通すと区切り自体が消え、`;` を書かない
 * SQL で複数の文が1つに結合される。結合されると「同じ文の中に IF NOT EXISTS がある」と
 * 誤判定して冪等性チェックが偽陰性になる(#264)。
 */
export function splitStatements(sql: string): string[] {
	return sql
		.split(/-->\s*statement-breakpoint/i)
		.flatMap((chunk) => stripComments(chunk).split(";"))
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length > 0);
}

/** ALTER TABLE ... DROP [COLUMN] col。SQLite は COLUMN を省略できる(#264)。 */
const ALTER_DROP = /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i;
/** ALTER TABLE ... ADD [COLUMN] ... NOT NULL(既存行を壊しうる+旧コードの INSERT が落ちる)。 */
const ADD_NOT_NULL = /\bALTER\s+TABLE\b[\s\S]*?\bADD\b[\s\S]*?\bNOT\s+NULL\b/i;
/** ALTER TABLE ... ADD [COLUMN]。SQLite では IF NOT EXISTS を書けない=本質的に非冪等。 */
const ALTER_ADD_COLUMN = /\bALTER\s+TABLE\b[\s\S]*?\bADD\b/i;

/**
 * 1ファイル分のSQLを検査して findings を返す。
 * allowDestructive=true なら破壊的判定は抑止し、冪等性チェックだけ行う。
 */
export function checkSql(
	content: string,
	{ allowDestructive = false }: { allowDestructive?: boolean } = {},
): MigrationFinding[] {
	const findings: MigrationFinding[] = [];
	const err = (message: string) => findings.push({ level: "error", message });
	const warn = (message: string) => findings.push({ level: "warn", message });
	const head = (stmt: string) => `"${stmt.slice(0, 80)}"`;

	for (const stmt of splitStatements(content)) {
		// --- 破壊的ステートメント(expand-and-contract 分割対象) ---
		if (!allowDestructive) {
			if (/\bDROP\s+TABLE\b/i.test(stmt)) {
				err(`DROP TABLE は破壊的です: ${head(stmt)}`);
			}
			// DROP COLUMN と、COLUMN を省略した ALTER TABLE ... DROP c の両方を拾う。
			if (ALTER_DROP.test(stmt)) {
				err(`カラム削除(ALTER TABLE ... DROP)は破壊的です: ${head(stmt)}`);
			}
			// ALTER TABLE ... RENAME [TO|COLUMN]
			if (/\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i.test(stmt)) {
				err(`RENAME は破壊的です: ${head(stmt)}`);
			}
			if (ADD_NOT_NULL.test(stmt)) {
				err(
					`NOT NULL の追加は破壊的です(旧コードの INSERT が落ちます): ${head(stmt)}`,
				);
			}
		}

		// --- 冪等性(IF NOT EXISTS / IF EXISTS)---
		if (
			/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt) &&
			!/\bIF\s+NOT\s+EXISTS\b/i.test(stmt)
		) {
			err(`CREATE INDEX に IF NOT EXISTS がありません: ${head(stmt)}`);
		}
		if (
			/\bCREATE\s+TABLE\b/i.test(stmt) &&
			!/\bIF\s+NOT\s+EXISTS\b/i.test(stmt)
		) {
			err(`CREATE TABLE に IF NOT EXISTS がありません: ${head(stmt)}`);
		}
		if (/\bDROP\s+TABLE\b/i.test(stmt) && !/\bIF\s+EXISTS\b/i.test(stmt)) {
			err(`DROP TABLE に IF EXISTS がありません: ${head(stmt)}`);
		}
		if (/\bDROP\s+INDEX\b/i.test(stmt) && !/\bIF\s+EXISTS\b/i.test(stmt)) {
			err(`DROP INDEX に IF EXISTS がありません: ${head(stmt)}`);
		}
		// ADD COLUMN は SQLite に IF NOT EXISTS が無く、書き直しようがないので警告に留める。
		// ここを error にすると通常のカラム追加が全てオプトアウト必須になり、マーカーが
		// 形骸化して本来止めたい DROP まで通ってしまう。
		if (ALTER_ADD_COLUMN.test(stmt) && !ALTER_DROP.test(stmt)) {
			warn(
				`ADD COLUMN は冪等にできません(SQLite に IF NOT EXISTS が無い)。` +
					`同番号の別ファイルが共有プレビューDBに二重適用されると以後の apply が全ブランチで` +
					`失敗します(#54)。連番が他のオープンPRと衝突していないか確認してください: ${head(stmt)}`,
			);
		}
	}
	return findings;
}

/** findings のうち CI を落とすもの(error)だけを返す。 */
export function errorsOf(findings: MigrationFinding[]): MigrationFinding[] {
	return findings.filter((f) => f.level === "error");
}
