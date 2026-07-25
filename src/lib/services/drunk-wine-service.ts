import { env } from "cloudflare:workers";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { drunkWine, wineTasting } from "#/db/schema";
import { jstDayKey } from "#/lib/dashboard/jst";
import {
	buildWinePhotoKey,
	MAX_PHOTOS_PER_ENTRY,
	resolveStoredPhotoMime,
} from "#/lib/drunk-wine/photo";
import type {
	CreateDrunkWineInput,
	CreateWineTastingInput,
	UpdateDrunkWineInput,
	UpdateWineTastingInput,
} from "#/lib/drunk-wine/schema";
import { DEFAULT_WINE_STATUS, type WineStatus } from "#/lib/drunk-wine/status";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import { getAop, getVariety } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";

// マイセラーのサービス層。Webのserver fnとMCPツールの共通入口で、
// D1(drunk_wine / wine_tasting)とR2(写真)への薄い橋渡しに徹する。
// AOP・品種は静的マスタ参照(FKなし)のため、ここで存在検証する。
//
// 所有状態(status)と飲用履歴(wine_tasting)は直交する2軸で、互いに自動連動しない
// (Issue #195)。唯一の例外は「飲んだ」操作(markWineDrunk)で、飲用記録の追加と
// status='finished' を1操作としてここに閉じている。

export interface DrunkWineEntry {
	id: string;
	name: string;
	status: WineStatus;
	/** 最新の飲用記録の飲んだ日。飲用記録が無い/全件日付未入力なら null */
	lastDrankOn: string | null;
	/** 飲用記録の件数。0 なら「まだ飲んだことがない」 */
	tastingCount: number;
	/** @deprecated lastDrankOn と同値。読み取り側の切り替えが済むまでの互換用 */
	drankOn: string | null;
	aopId: string | null;
	/** AOP紐付け時のみ。静的マスタから導出 */
	aopNameJa: string | null;
	regionId: RegionId | null;
	/** @deprecated 最新の飲用記録の射影。互換用 */
	rating: number | null;
	/** @deprecated 最新の飲用記録の射影。互換用 */
	memo: string | null;
	vintage: number | null;
	grapeVarietyIds: string[];
	producer: string | null;
	price: number | null;
	/** 写真の相対URL(/api/images/...)の配列。表示順で先頭=代表。呼び出し側で必要なら絶対化する */
	photoUrls: string[];
	createdAt: number;
	updatedAt: number;
}

export interface WineTastingEntry {
	id: string;
	drankOn: string | null;
	rating: number | null;
	memo: string | null;
	createdAt: number;
	updatedAt: number;
}

type DrunkWineRow = typeof drunkWine.$inferSelect;
type WineTastingRow = typeof wineTasting.$inferSelect;

function toEntry(row: DrunkWineRow): DrunkWineEntry {
	const aop = row.aopId ? getAop(row.aopId) : undefined;
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		lastDrankOn: row.lastDrankOn,
		tastingCount: row.tastingCount,
		drankOn: row.drankOn,
		aopId: row.aopId,
		aopNameJa: aop?.nameJa ?? null,
		regionId: aop?.region ?? null,
		rating: row.rating,
		memo: row.memo,
		vintage: row.vintage,
		grapeVarietyIds: row.grapeVarietyIds,
		producer: row.producer,
		price: row.price,
		photoUrls: row.photoKeys.map((key) => `/api/images/${key}`),
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

function toTastingEntry(row: WineTastingRow): WineTastingEntry {
	return {
		id: row.id,
		drankOn: row.drankOn,
		rating: row.rating,
		memo: row.memo,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

// ---- 集計キャッシュの再計算 -----------------------------------------------
// 飲用記録を書き換えるすべての経路が、変更文と同じ db.batch にこの UPDATE を積む。
// D1 の batch は暗黙トランザクションで文を順次実行するため、この UPDATE は先行の
// INSERT/DELETE の結果を見る。
//
// 加算・減算(quiz-service の `col + 1` / `max(0, col - 1)`)ではなく全再計算にする:
// last_drank_on は MAX なので、削除や日付変更で「次に大きい値」へ戻す必要があり
// incremental 更新では原理的に表現できない。全再計算なら冪等で、マイグレーションの
// バックフィルと完全に同じ式を使え、整合が崩れても打ち直せば復旧する。

/** 「最新の飲用記録」の定義。SQLite は DESC で NULL を先頭に置くため、
 *  第1キーで日付未入力を末尾へ落とす。これで「最新行の drank_on」と
 *  「max(drank_on)」が常に一致する。 */
const LATEST_TASTING_ORDER = sql`order by ${wineTasting.drankOn} is null, ${wineTasting.drankOn} desc, ${wineTasting.createdAt} desc`;

function latestTastingValue(
	column: typeof wineTasting.rating | typeof wineTasting.memo,
) {
	return sql`(select ${column} from ${wineTasting} where ${wineTasting.drunkWineId} = ${drunkWine.id} ${LATEST_TASTING_ORDER} limit 1)`;
}

const TASTING_COUNT_EXPR = sql`(select count(*) from ${wineTasting} where ${wineTasting.drunkWineId} = ${drunkWine.id})`;
const MAX_DRANK_ON_EXPR = sql`(select max(${wineTasting.drankOn}) from ${wineTasting} where ${wineTasting.drunkWineId} = ${drunkWine.id})`;

/**
 * 飲用記録から集計キャッシュを再計算する UPDATE を組み立てる(実行はしない。
 * 呼び出し側が db.batch に積む)。旧列 drank_on/rating/memo への二重書きも
 * ここで行う — 同じ SET に3行足すだけで、一覧・地図・MCP payload の読み取り側を
 * 触らずに済む(expand-and-contract。次PRでこの3行と列を同時に削除する)。
 *
 * extra で status も同時に変えられる(markWineDrunk が使う)。
 */
function recomputeDrunkWineAggregates(
	userId: string,
	drunkWineId: string,
	extra?: { status?: WineStatus },
) {
	return db
		.update(drunkWine)
		.set({
			tastingCount: TASTING_COUNT_EXPR,
			lastDrankOn: MAX_DRANK_ON_EXPR,
			drankOn: MAX_DRANK_ON_EXPR,
			rating: latestTastingValue(wineTasting.rating),
			memo: latestTastingValue(wineTasting.memo),
			...(extra?.status ? { status: extra.status } : {}),
		})
		.where(and(eq(drunkWine.id, drunkWineId), eq(drunkWine.userId, userId)))
		.returning();
}

/** 所有権を確認して銘柄の存在を保証する。存在しない/他ユーザは同一エラー。 */
async function assertOwnsDrunkWine(
	userId: string,
	drunkWineId: string,
): Promise<void> {
	const [row] = await db
		.select({ id: drunkWine.id })
		.from(drunkWine)
		.where(and(eq(drunkWine.id, drunkWineId), eq(drunkWine.userId, userId)));
	if (!row) throw new NotFoundError("Entry not found");
}

function assertValidRefs(input: {
	aopId?: string | null;
	grapeVarietyIds?: string[];
}) {
	if (input.aopId && !getAop(input.aopId)) {
		throw new BadRequestError(`Unknown AOP: ${input.aopId}`);
	}
	for (const id of input.grapeVarietyIds ?? []) {
		if (!getVariety(id)) {
			throw new BadRequestError(`Unknown grape variety: ${id}`);
		}
	}
}

// 作成入力。Web(zodのCreateDrunkWineInput)に加え、MCPツールが共通の
// snake→camelマッピング(toCamelPatch)をそのまま渡せるよう null も受け付ける
// (下で ?? null に正規化されるため null と undefined は等価)。
type CreateDrunkWineData = Omit<UpdateDrunkWineInput, "id"> & {
	name: string;
	tasting?: CreateWineTastingInput;
};

export async function createDrunkWine(
	userId: string,
	input: CreateDrunkWineInput | CreateDrunkWineData,
): Promise<DrunkWineEntry> {
	assertValidRefs(input);
	const id = crypto.randomUUID();
	const status = input.status ?? DEFAULT_WINE_STATUS;
	// finished(手元にない)は「飲み終えた」の意なので、入力が無くても日付なしの
	// 飲用記録を1件作る。これにより「名前だけ入れて記録する」既存UX・旧データの
	// バックフィル規則・status を送らない旧MCPクライアントの挙動が同一になる。
	const tasting =
		input.tasting ??
		(status === "finished" ? ({} as CreateWineTastingInput) : undefined);

	const values = {
		id,
		userId,
		name: input.name,
		status,
		aopId: input.aopId ?? null,
		vintage: input.vintage ?? null,
		grapeVarietyIds: input.grapeVarietyIds ?? [],
		producer: input.producer ?? null,
		price: input.price ?? null,
	};

	if (!tasting) {
		const [row] = await db.insert(drunkWine).values(values).returning();
		if (!row) throw new Error("Failed to insert drunk wine");
		return toEntry(row);
	}

	// 銘柄と飲用記録を1トランザクションで作る(写真と違いR2キーの物理制約が無い)。
	// 3文目の再計算の returning から最終状態を得る。
	const [, , updated] = await db.batch([
		db.insert(drunkWine).values(values),
		db.insert(wineTasting).values(buildTastingValues(userId, id, tasting)),
		recomputeDrunkWineAggregates(userId, id),
	]);
	const row = updated[0];
	if (!row) throw new Error("Failed to insert drunk wine");
	return toEntry(row);
}

export async function updateDrunkWine(
	userId: string,
	input: UpdateDrunkWineInput,
): Promise<DrunkWineEntry> {
	assertValidRefs(input);
	const { id, ...patch } = input;
	// undefined = 変更しない / null = クリア。undefinedキーはdrizzleが無視する
	const [row] = await db
		.update(drunkWine)
		.set({
			name: patch.name,
			status: patch.status,
			aopId: patch.aopId,
			vintage: patch.vintage,
			grapeVarietyIds: patch.grapeVarietyIds,
			producer: patch.producer,
			price: patch.price,
		})
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning();
	// 存在しない/他ユーザ所有を区別せず同じエラーにする(存在の探索を防ぐ)
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

// ---- 飲用記録 -------------------------------------------------------------

function buildTastingValues(
	userId: string,
	drunkWineId: string,
	input: CreateWineTastingInput,
) {
	return {
		id: crypto.randomUUID(),
		drunkWineId,
		userId,
		drankOn: input.drankOn ?? null,
		rating: input.rating ?? null,
		memo: input.memo ?? null,
	};
}

export async function listWineTastings(
	userId: string,
	drunkWineId: string,
): Promise<WineTastingEntry[]> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	const rows = await db
		.select()
		.from(wineTasting)
		.where(
			and(
				eq(wineTasting.drunkWineId, drunkWineId),
				eq(wineTasting.userId, userId),
			),
		)
		.orderBy(
			sql`${wineTasting.drankOn} is null`,
			desc(wineTasting.drankOn),
			desc(wineTasting.createdAt),
		);
	return rows.map(toTastingEntry);
}

export async function addWineTasting(
	userId: string,
	drunkWineId: string,
	input: CreateWineTastingInput,
): Promise<DrunkWineEntry> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	const [, updated] = await db.batch([
		db
			.insert(wineTasting)
			.values(buildTastingValues(userId, drunkWineId, input)),
		recomputeDrunkWineAggregates(userId, drunkWineId),
	]);
	const row = updated[0];
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

/** 所有する飲用記録を引く。存在しない/他ユーザは同一エラー。 */
async function findOwnedTasting(userId: string, tastingId: string) {
	const [row] = await db
		.select({
			id: wineTasting.id,
			drunkWineId: wineTasting.drunkWineId,
		})
		.from(wineTasting)
		.where(and(eq(wineTasting.id, tastingId), eq(wineTasting.userId, userId)));
	if (!row) throw new NotFoundError("Entry not found");
	return row;
}

/**
 * 飲用記録1件を更新する文を組み立てる。全キーが未指定なら null を返す
 * (drizzle は空の SET を "No values to set" で拒否するため)。集計の再計算だけは
 * 呼び出し側が常に実行する — 冪等なので、整合が崩れたときの復旧手段になる。
 */
function buildTastingUpdate(
	userId: string,
	tastingId: string,
	patch: {
		drankOn?: string | null;
		rating?: number | null;
		memo?: string | null;
	},
) {
	if (
		patch.drankOn === undefined &&
		patch.rating === undefined &&
		patch.memo === undefined
	) {
		return null;
	}
	return db
		.update(wineTasting)
		.set({ drankOn: patch.drankOn, rating: patch.rating, memo: patch.memo })
		.where(and(eq(wineTasting.id, tastingId), eq(wineTasting.userId, userId)));
}

export async function updateWineTasting(
	userId: string,
	input: UpdateWineTastingInput,
): Promise<DrunkWineEntry> {
	const { id, ...patch } = input;
	const target = await findOwnedTasting(userId, id);
	const update = buildTastingUpdate(userId, id, patch);
	const recompute = recomputeDrunkWineAggregates(userId, target.drunkWineId);
	const results = await db.batch(update ? [update, recompute] : [recompute]);
	const row = (results.at(-1) as (typeof drunkWine.$inferSelect)[])[0];
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

export async function deleteWineTasting(
	userId: string,
	tastingId: string,
): Promise<DrunkWineEntry> {
	const target = await findOwnedTasting(userId, tastingId);
	const [, updated] = await db.batch([
		db
			.delete(wineTasting)
			.where(
				and(eq(wineTasting.id, tastingId), eq(wineTasting.userId, userId)),
			),
		recomputeDrunkWineAggregates(userId, target.drunkWineId),
	]);
	const row = updated[0];
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

/**
 * 「飲んだ」操作。飲用記録の追加と status='finished' を1操作で行う。
 * 本数を管理しない以上これが既定として自然で、ストックが残っている場合は
 * 編集画面から owned に戻せる。2軸を同時に動かす唯一の経路をここに閉じる。
 */
export async function markWineDrunk(
	userId: string,
	drunkWineId: string,
	input?: CreateWineTastingInput,
): Promise<DrunkWineEntry> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	const tasting: CreateWineTastingInput = {
		...input,
		drankOn: input?.drankOn ?? jstDayKey(new Date()),
	};
	const [, updated] = await db.batch([
		db
			.insert(wineTasting)
			.values(buildTastingValues(userId, drunkWineId, tasting)),
		recomputeDrunkWineAggregates(userId, drunkWineId, { status: "finished" }),
	]);
	const row = updated[0];
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

/**
 * MCP のレガシー引数(register/update の drank_on / rating / memo)専用。
 * 「最新の飲用記録を in-place で更新する」— 新規追加はしない。MCP App の編集
 * フォームは保存のたびに update_drunk_wine を投げるため、追加にすると保存を
 * 押すたびに tasting_count が増えてしまう。
 *
 * 飲用記録が0件のときは、非 null の値が1つでもあれば1件作る(全部 null なら no-op)。
 * null は「その列をクリア」の意で、行は消さない(旧セマンティクスは列のクリアで
 * あって記録の削除ではない)。
 */
export async function updateLatestWineTasting(
	userId: string,
	drunkWineId: string,
	patch: {
		drankOn?: string | null;
		rating?: number | null;
		memo?: string | null;
	},
): Promise<DrunkWineEntry | null> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	const [latest] = await db
		.select({ id: wineTasting.id })
		.from(wineTasting)
		.where(
			and(
				eq(wineTasting.drunkWineId, drunkWineId),
				eq(wineTasting.userId, userId),
			),
		)
		.orderBy(
			sql`${wineTasting.drankOn} is null`,
			desc(wineTasting.drankOn),
			desc(wineTasting.createdAt),
		)
		.limit(1);

	if (!latest) {
		const hasValue = [patch.drankOn, patch.rating, patch.memo].some(
			(v) => v !== undefined && v !== null,
		);
		if (!hasValue) return null;
		return addWineTasting(userId, drunkWineId, {
			drankOn: patch.drankOn ?? undefined,
			rating: patch.rating ?? undefined,
			memo: patch.memo ?? undefined,
		});
	}

	const update = buildTastingUpdate(userId, latest.id, patch);
	const recompute = recomputeDrunkWineAggregates(userId, drunkWineId);
	const results = await db.batch(update ? [update, recompute] : [recompute]);
	const row = (results.at(-1) as (typeof drunkWine.$inferSelect)[])[0];
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

export async function deleteDrunkWine(
	userId: string,
	id: string,
): Promise<void> {
	const [row] = await db
		.delete(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning({ photoKeys: drunkWine.photoKeys });
	if (!row) throw new NotFoundError("Entry not found");
	// R2は複数キー一括削除に対応(存在しないキーは無視される)
	if (row.photoKeys.length > 0) await env.AVATARS.delete(row.photoKeys);
}

export async function listDrunkWines(
	userId: string,
): Promise<DrunkWineEntry[]> {
	const rows = await db
		.select()
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId))
		.orderBy(desc(drunkWine.createdAt));
	return rows.map(toEntry);
}

/**
 * ダッシュボードのサマリー表示用。
 * - tastedCount: 飲んだことがある銘柄数(所有状態に依存しない)
 * - totalCount: マイセラーの登録総数(未飲・気になるを含む)
 * - latest: 直近の登録1件(createdAt 降順の先頭。index drunk_wine_user_created_idx が効く)
 *
 * 旧 countAndLatestDrunkWine の `count` は「登録総数」だったが、未飲ワインを
 * 登録できるようになり「飲んだ本数」と一致しなくなった。意味の異なる2つを
 * 別名で返し、呼び出し側にどちらを使うか選ばせる。
 */
export async function getCellarSummary(userId: string): Promise<{
	tastedCount: number;
	totalCount: number;
	latest: DrunkWineEntry | null;
}> {
	const [countRow] = await db
		.select({
			total: sql<number>`count(*)`,
			tasted: sql<number>`sum(case when ${drunkWine.tastingCount} > 0 then 1 else 0 end)`,
		})
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId));
	const [latestRow] = await db
		.select()
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId))
		.orderBy(desc(drunkWine.createdAt))
		.limit(1);
	return {
		tastedCount: countRow?.tasted ?? 0,
		totalCount: countRow?.total ?? 0,
		latest: latestRow ? toEntry(latestRow) : null,
	};
}

export async function getDrunkWine(
	userId: string,
	id: string,
): Promise<DrunkWineEntry> {
	const [row] = await db
		.select()
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

/** syncDrunkWinePhotos に渡す最終並び順の1要素。既存キーの保持か、新規バイト列の追加。 */
export type PhotoLayoutItem =
	| { kind: "existing"; key: string }
	| { kind: "new"; bytes: Uint8Array | ArrayBuffer; mimeType: string };

/**
 * エントリの写真集合を layout(最終並び順)へ全置換で同期する。追加・削除・並べ替え・
 * 差し替えを1回で反映する。新規はR2へ保存し、旧配列にあって残らないキーは削除して
 * 残骸を残さない。layout の existing キーは対象エントリの現在の集合に属するもののみ
 * 許可する(他エントリ/任意キーの注入を防ぐ)。Webルート・MCPツール共用。
 */
export async function syncDrunkWinePhotos(
	userId: string,
	id: string,
	layout: PhotoLayoutItem[],
): Promise<DrunkWineEntry> {
	if (layout.length > MAX_PHOTOS_PER_ENTRY) {
		throw new BadRequestError(`写真は最大${MAX_PHOTOS_PER_ENTRY}枚までです`);
	}
	const [existing] = await db
		.select({ photoKeys: drunkWine.photoKeys })
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!existing) throw new NotFoundError("Entry not found");

	const currentKeys = existing.photoKeys;
	const currentSet = new Set(currentKeys);
	for (const item of layout) {
		if (item.kind === "existing" && !currentSet.has(item.key)) {
			throw new BadRequestError("Unknown photo");
		}
	}

	// 新規をR2へ保存しつつ最終キー配列を組み立てる。put途中で失敗したら今回put分を巻き戻す
	const putKeys: string[] = [];
	const nextKeys: string[] = [];
	try {
		for (const item of layout) {
			if (item.kind === "existing") {
				nextKeys.push(item.key);
				continue;
			}
			// 保存するContent-Typeは申告値ではなく実バイト(マジックバイト)から確定する。
			// 中身がHTML/スクリプト等の画像偽装や、申告と実フォーマットの食い違いを拒否する(#150)。
			const bytes =
				item.bytes instanceof Uint8Array
					? item.bytes
					: new Uint8Array(item.bytes);
			const mime = resolveStoredPhotoMime(bytes, item.mimeType);
			if (!mime) {
				throw new BadRequestError(
					"画像として認識できないか、形式が申告値と一致しないファイルが含まれています",
				);
			}
			const key = buildWinePhotoKey(userId, id, crypto.randomUUID(), mime);
			await env.AVATARS.put(key, bytes, {
				httpMetadata: { contentType: mime },
			});
			putKeys.push(key);
			nextKeys.push(key);
		}
	} catch (e) {
		if (putKeys.length > 0) await env.AVATARS.delete(putKeys);
		throw e;
	}

	const [row] = await db
		.update(drunkWine)
		.set({ photoKeys: nextKeys })
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning();
	// 存在確認とここまでの間にエントリが削除された場合、put分を掃除する
	if (!row) {
		if (putKeys.length > 0) await env.AVATARS.delete(putKeys);
		throw new NotFoundError("Entry not found");
	}

	// 旧配列にあって新配列に残らないキーを削除(削除・差し替え・並べ替えを一括反映)
	const nextSet = new Set(nextKeys);
	const removed = currentKeys.filter((key) => !nextSet.has(key));
	if (removed.length > 0) await env.AVATARS.delete(removed);

	return toEntry(row);
}
