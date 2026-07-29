#!/usr/bin/env bun
// 破壊的マイグレーション(expand-and-contract 分割漏れ)と冪等性欠如を機械的に検出する(#137 / #264)。
//
// CLAUDE.md / docs/architecture.md の運用ルール:
//  - 破壊的なスキーマ変更(DROP TABLE/COLUMN・RENAME・NOT NULL 追加)は expand-and-contract で
//    2段階に分ける(#24)
//  - マイグレーションは冪等に書く(CREATE ... IF NOT EXISTS / DROP ... IF EXISTS)(#54)
//
// 検査ロジック本体は src/lib/migrations/destructive.ts(純ロジック・単体テストあり)。
// このスクリプトは「どのファイルを対象にするか」と終了コードだけを担う。
// TS を直接 import するため node ではなく **bun** で実行する(package.json の check:migrations)。
//
// 使い方:
//   bun scripts/check-destructive-migrations.mjs                # git diff (BASE_REF...HEAD) の追加/変更SQL
//   bun scripts/check-destructive-migrations.mjs a.sql b.sql    # 明示ファイル(手元確認用)
//   BASE_REF=origin/main bun scripts/check-destructive-migrations.mjs
//
// オプトアウト: 意図的に破壊的変更を通す場合(参照コード削除を先行デプロイ済み等)は、
// 対象SQLファイル先頭付近に `-- allow-destructive-migration` マーカーコメントを置く。
// これで「破壊的」判定のみ抑止される(冪等性チェックは維持)。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
	checkSql,
	errorsOf,
	hasAllowDestructiveMarker,
} from "../src/lib/migrations/destructive.ts";

/** git diff で BASE_REF...HEAD の追加/変更 drizzle/*.sql を返す。失敗時は例外。 */
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
			// 対象を決められない = 検査できていない。以前はここで fail-open していたが、
			// 「チェックが動かなかった」と「違反が無かった」が同じ緑になり、浅いクローンや
			// base ref の取り違えで検査が黙って無効化される(#264)。既定は fail-closed。
			// 検査を意図的に飛ばす場合だけ MIGRATION_CHECK_ALLOW_SKIP=1 を明示する。
			const msg = `git diff (${baseRef}...HEAD) に失敗しました: ${e.message}`;
			if (process.env.MIGRATION_CHECK_ALLOW_SKIP === "1") {
				console.warn(
					`[check-destructive-migrations] ${msg}\n` +
						"  MIGRATION_CHECK_ALLOW_SKIP=1 のためスキップします。",
				);
				return 0;
			}
			console.error(
				`[check-destructive-migrations] ${msg}\n` +
					"  BASE_REF を指定するか(例: BASE_REF=origin/main)、checkout の fetch-depth を 0 にしてください。\n" +
					"  意図的にスキップする場合は MIGRATION_CHECK_ALLOW_SKIP=1 を指定してください。",
			);
			return 1;
		}
	}

	if (files.length === 0) {
		console.log(
			"[check-destructive-migrations] 対象の追加/変更マイグレーションはありません。",
		);
		return 0;
	}

	let errorCount = 0;
	for (const file of files) {
		let content;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			// 変更検出されたが読めない(削除された等)はスキップ
			continue;
		}
		const allowDestructive = hasAllowDestructiveMarker(content);
		const findings = checkSql(content, { allowDestructive });
		const errors = errorsOf(findings);
		const warnings = findings.filter((f) => f.level === "warn");
		errorCount += errors.length;

		if (errors.length > 0) {
			console.error(`\n✗ ${file}`);
			for (const v of errors) console.error(`  - ${v.message}`);
			for (const v of warnings) console.error(`  ! ${v.message}`);
		} else {
			console.log(
				`✓ ${file}${allowDestructive ? " (allow-destructive-migration)" : ""}`,
			);
			for (const v of warnings) console.warn(`  ! ${v.message}`);
		}
	}

	if (errorCount > 0) {
		console.error(
			`\n${errorCount} 件の違反を検出しました。破壊的変更は expand-and-contract で分割し(#24)、` +
				`マイグレーションは冪等(IF NOT EXISTS / IF EXISTS)に書いてください(#54)。\n` +
				`意図的に破壊的変更を通す場合は、対象SQLに "-- allow-destructive-migration" を記載してください。`,
		);
		return 1;
	}
	console.log("\nマイグレーションチェック: 問題なし。");
	return 0;
}

// スクリプトとして直接実行された時のみ走らせる
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exit(main());
}
