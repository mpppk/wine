#!/usr/bin/env node
// 破壊的マイグレーション(expand-and-contract 分割漏れ)と冪等性欠如を機械的に検出する(#137)。
//
// CLAUDE.md / docs/architecture.md の運用ルール:
//  - 破壊的なスキーマ変更(DROP TABLE/COLUMN・RENAME 等)は expand-and-contract で2段階に分ける(#24)
//  - マイグレーションは冪等に書く(CREATE ... IF NOT EXISTS / DROP ... IF EXISTS)(#54)
// これらは従来ドキュメントとレビューの注意力だけに依存していた。本スクリプトを CI で走らせ、
// 追加/変更された drizzle/*.sql を対象に違反を検出する。
//
// 使い方:
//   node scripts/check-destructive-migrations.mjs                # git diff (BASE_REF..HEAD) の追加/変更SQLを対象
//   node scripts/check-destructive-migrations.mjs a.sql b.sql    # 明示ファイルを対象(テスト用)
//   BASE_REF=origin/main node scripts/check-destructive-migrations.mjs
//
// オプトアウト: 意図的に破壊的変更を通す場合(参照コード削除を先行デプロイ済み等)は、
// 対象SQLファイル先頭付近に `-- allow-destructive-migration` マーカーコメントを置く。
// これで「破壊的」判定のみ抑止される(冪等性チェックは維持)。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** SQLから行コメント(-- ...)とブロックコメント(/* ... *\/)を除去する。 */
function stripComments(sql) {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/--[^\n]*/g, " ");
}

/** SQL本文を文単位に分割する(`;` と drizzle の statement-breakpoint 双方に対応)。 */
function splitStatements(sql) {
	return stripComments(sql)
		.split(/;|-->\s*statement-breakpoint/i)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length > 0);
}

/**
 * 1ファイル分のSQLを検査し、違反メッセージ配列を返す。
 * allowDestructive=true なら破壊的判定は抑止し、冪等性チェックのみ行う。
 */
export function checkSql(content, { allowDestructive = false } = {}) {
	const violations = [];
	for (const stmt of splitStatements(content)) {
		// --- 破壊的ステートメント(expand-and-contract 分割対象) ---
		if (!allowDestructive) {
			if (/\bDROP\s+TABLE\b/i.test(stmt)) {
				violations.push(`DROP TABLE は破壊的です: "${stmt.slice(0, 80)}"`);
			}
			if (/\bDROP\s+COLUMN\b/i.test(stmt)) {
				violations.push(`DROP COLUMN は破壊的です: "${stmt.slice(0, 80)}"`);
			}
			// ALTER TABLE ... RENAME [TO|COLUMN]
			if (/\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i.test(stmt)) {
				violations.push(`RENAME は破壊的です: "${stmt.slice(0, 80)}"`);
			}
		}
		// --- 冪等性(IF NOT EXISTS / IF EXISTS)---
		if (
			/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt) &&
			!/\bIF\s+NOT\s+EXISTS\b/i.test(stmt)
		) {
			violations.push(
				`CREATE INDEX に IF NOT EXISTS がありません: "${stmt.slice(0, 80)}"`,
			);
		}
		if (
			/\bCREATE\s+TABLE\b/i.test(stmt) &&
			!/\bIF\s+NOT\s+EXISTS\b/i.test(stmt)
		) {
			violations.push(
				`CREATE TABLE に IF NOT EXISTS がありません: "${stmt.slice(0, 80)}"`,
			);
		}
		if (/\bDROP\s+TABLE\b/i.test(stmt) && !/\bIF\s+EXISTS\b/i.test(stmt)) {
			violations.push(
				`DROP TABLE に IF EXISTS がありません: "${stmt.slice(0, 80)}"`,
			);
		}
		if (/\bDROP\s+INDEX\b/i.test(stmt) && !/\bIF\s+EXISTS\b/i.test(stmt)) {
			violations.push(
				`DROP INDEX に IF EXISTS がありません: "${stmt.slice(0, 80)}"`,
			);
		}
	}
	return violations;
}

/** git diff で BASE_REF..HEAD の追加/変更 drizzle/*.sql を返す。失敗時は例外。 */
function changedMigrationFiles(baseRef) {
	const out = execFileSync(
		"git",
		[
			"diff",
			"--name-only",
			"--diff-filter=AM",
			`${baseRef}...HEAD`,
			"--",
			"drizzle/*.sql",
		],
		{ encoding: "utf8" },
	);
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

function main() {
	const argFiles = process.argv.slice(2);
	let files;
	if (argFiles.length > 0) {
		files = argFiles;
	} else {
		const baseRef = process.env.BASE_REF || "origin/main";
		try {
			files = changedMigrationFiles(baseRef);
		} catch (e) {
			// base ref が取得できない等(浅いクローン)。CIでは checkout の fetch-depth:0 を
			// 前提にするが、取得失敗で全PRをブロックしないよう明示して fail-open する。
			console.warn(
				`[check-destructive-migrations] git diff (${baseRef}...HEAD) に失敗したためスキップ: ${e.message}`,
			);
			return 0;
		}
	}

	if (files.length === 0) {
		console.log(
			"[check-destructive-migrations] 対象の追加/変更マイグレーションはありません。",
		);
		return 0;
	}

	let total = 0;
	for (const file of files) {
		let content;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			// 変更検出されたが読めない(削除された等)はスキップ
			continue;
		}
		const allowDestructive = /--\s*allow-destructive-migration/i.test(content);
		const violations = checkSql(content, { allowDestructive });
		if (violations.length > 0) {
			total += violations.length;
			console.error(`\n✗ ${file}`);
			for (const v of violations) console.error(`  - ${v}`);
		} else {
			console.log(
				`✓ ${file}${allowDestructive ? " (allow-destructive-migration)" : ""}`,
			);
		}
	}

	if (total > 0) {
		console.error(
			`\n${total} 件の違反を検出しました。破壊的変更は expand-and-contract で分割し(#24)、` +
				`マイグレーションは冪等(IF NOT EXISTS / IF EXISTS)に書いてください(#54)。\n` +
				`意図的に破壊的変更を通す場合は、対象SQLに "-- allow-destructive-migration" を記載してください。`,
		);
		return 1;
	}
	console.log("\nマイグレーションチェック: 問題なし。");
	return 0;
}

// スクリプトとして直接実行された時のみ走らせる(import 時は checkSql だけ使える)
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exit(main());
}
