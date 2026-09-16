/**
 * 一括登録の写真を、その回に登録した銘柄へ後から複製する一度きりの復旧スクリプト(#617)。
 *
 * 一括抽出をジョブ化(#474)した後、レビュー画面の確定が写真をバッチへ「引き継ぐ」経路は
 * 銘柄への複製(#473 の3段目)を通っておらず、その回に作られた銘柄は `photo_keys` が
 * 空のままだった。コード側は `attachImportBatchPhotoKeys` に関門を寄せて直したが、
 * **既に登録済みの銘柄は空のまま**なので、ここで同じ複製を後追いで行う。
 *
 * 本番の Worker の外から走らせるため、R2 と D1 には wrangler CLI 経由で触る。やることは
 * `adoptBatchPhotosForWines`(src/lib/services/drunk-wine-service.ts)と同じ:
 *
 *   1. バッチ由来の銘柄のうち `photo_keys` が空のものを拾う
 *   2. その回の体験記録が指すバッチ写真(`photo_indexes`)を R2 から読み、**複製**を置く
 *      (参照にするとバッチ取り消しで銘柄の写真が消える)
 *   3. `photo_keys` / `photo_kinds`(= bottle)を埋める
 *
 * 保存する Content-Type は元キーの拡張子から復元する。拡張子は保存時に実バイトから
 * 確定した MIME の写し(`buildWinePhotoKey`)なので、往復して同じ値になる。
 *
 * **既定は dry run**。`--apply` を付けたときだけ書き込む。`photo_keys` が空の行だけを
 * 対象にするので、二度流しても二重には複製しない。
 *
 * 使い方:
 *   bun scripts/backfill-batch-photos-to-wines.ts                  # 対象の確認(本番)
 *   bun scripts/backfill-batch-photos-to-wines.ts --apply          # 複製する(本番)
 *   bun scripts/backfill-batch-photos-to-wines.ts --env preview --apply
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ALLOWED_PHOTO_TYPES,
	buildWinePhotoKey,
	MAX_PHOTOS_PER_ENTRY,
	photoExtForMime,
} from "#/lib/drunk-wine/photo";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const envIndex = args.indexOf("--env");
const targetEnv = envIndex >= 0 ? args[envIndex + 1] : undefined;
/** 本番 `wine` は既定env、プレビューは `--env preview`。バケット名は wrangler.jsonc と対。 */
const bucket =
	targetEnv === "preview" ? "avatars-wine-preview" : "avatars-wine";

/** 拡張子 → 保存時の Content-Type。`photoExtForMime` の逆引き(許可4種のみ)。 */
function mimeForKey(key: string): string | undefined {
	const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
	for (const mime of ALLOWED_PHOTO_TYPES) {
		if (photoExtForMime(mime) === ext) return mime;
	}
	return undefined;
}

function wrangler(argv: string[]): string {
	return execFileSync(
		"bunx",
		["wrangler", ...argv, ...(targetEnv ? ["--env", targetEnv] : [])],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
}

function d1<T>(sql: string): T[] {
	// `-c` は wrangler のグローバルフラグ(--config)なので短縮形を使わない。
	const out = wrangler([
		"d1",
		"execute",
		"DB",
		"--remote",
		"--json",
		"--command",
		sql,
	]);
	// 先頭に警告行が混ざることがあるので、JSON の開始位置から読む
	const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
		results: T[];
	}[];
	return parsed.flatMap((r) => r.results ?? []);
}

interface Row {
	wine_id: string;
	user_id: string;
	batch_photo_keys: string;
	photo_indexes: string | null;
	photo_index: number | null;
}

/** 体験記録が指すバッチ写真の番号(`encounterPhotoIndexes` と同じ規則)。 */
function indexesOf(row: Row): number[] {
	const stored: unknown = row.photo_indexes
		? JSON.parse(row.photo_indexes)
		: row.photo_index != null
			? [row.photo_index]
			: [];
	const out = new Set<number>();
	for (const raw of Array.isArray(stored) ? stored : []) {
		if (Number.isInteger(raw) && (raw as number) >= 0) out.add(raw as number);
	}
	return [...out].sort((a, b) => a - b);
}

const rows = d1<Row>(`
	SELECT w.id AS wine_id, w.user_id, b.photo_keys AS batch_photo_keys,
	       e.photo_indexes, e.photo_index
	FROM drunk_wine w
	JOIN import_batch b ON b.id = w.batch_id
	JOIN wine_encounter e ON e.drunk_wine_id = w.id AND e.batch_id = w.batch_id
	WHERE json_array_length(w.photo_keys) = 0
	  AND json_array_length(b.photo_keys) > 0
`);

// 1銘柄に同じバッチの体験記録が複数ある場合は写真番号を合わせて持つ(#574 の
// 「対応写真のすべて」と同じ扱い)。
const byWine = new Map<string, { userId: string; keys: string[] }>();
for (const row of rows) {
	const batchKeys = JSON.parse(row.batch_photo_keys) as string[];
	const current = byWine.get(row.wine_id) ?? {
		userId: row.user_id,
		keys: [] as string[],
	};
	for (const index of indexesOf(row)) {
		const key = batchKeys[index];
		if (key && !current.keys.includes(key)) current.keys.push(key);
	}
	byWine.set(row.wine_id, current);
}

const targets = [...byWine.entries()].filter(([, v]) => v.keys.length > 0);
console.log(
	`対象: ${targets.length}銘柄 / 複製する写真 ${targets.reduce(
		(n, [, v]) => n + Math.min(v.keys.length, MAX_PHOTOS_PER_ENTRY),
		0,
	)}枚 (${apply ? "APPLY" : "dry run"}, env=${targetEnv ?? "production"})`,
);

const workDir = mkdtempSync(join(tmpdir(), "wine-backfill-"));
try {
	for (const [wineId, { userId, keys }] of targets) {
		const sources = keys.slice(0, MAX_PHOTOS_PER_ENTRY);
		const newKeys: string[] = [];
		for (const sourceKey of sources) {
			const mime = mimeForKey(sourceKey);
			if (!mime) {
				console.warn(`  skip (未対応の拡張子): ${sourceKey}`);
				continue;
			}
			const newKey = buildWinePhotoKey(
				userId,
				wineId,
				crypto.randomUUID(),
				mime,
			);
			console.log(`  ${wineId}: ${sourceKey} -> ${newKey}`);
			if (!apply) {
				newKeys.push(newKey);
				continue;
			}
			const file = join(workDir, "photo.bin");
			wrangler([
				"r2",
				"object",
				"get",
				`${bucket}/${sourceKey}`,
				"--remote",
				"--file",
				file,
			]);
			wrangler([
				"r2",
				"object",
				"put",
				`${bucket}/${newKey}`,
				"--remote",
				"--file",
				file,
				"--content-type",
				mime,
			]);
			newKeys.push(newKey);
		}
		if (newKeys.length === 0 || !apply) continue;
		// ID は D1 から読んだ UUID だが、SQL へ素で埋めるので形だけ確かめる
		// (CLI の d1 execute にプレースホルダが無いため)。
		if (!/^[0-9a-f-]{36}$/i.test(wineId)) {
			throw new Error(`想定外のID: ${wineId}`);
		}
		// 空の行だけを更新する(二重実行でも複製が積み上がらない)。
		const kinds = newKeys.map(() => "bottle");
		d1(`
			UPDATE drunk_wine
			SET photo_keys = '${JSON.stringify(newKeys)}',
			    photo_kinds = '${JSON.stringify(kinds)}'
			WHERE id = '${wineId}' AND json_array_length(photo_keys) = 0
		`);
	}
} finally {
	rmSync(workDir, { recursive: true, force: true });
}
console.log(
	apply ? "完了" : "dry run のため書き込みはしていません(--apply で実行)",
);
