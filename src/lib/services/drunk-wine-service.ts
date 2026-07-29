import { env } from "cloudflare:workers";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "#/db";
import { drunkWine, wineTasting } from "#/db/schema";
import { jstDayKey } from "#/lib/dashboard/jst";
import {
	type CellarFilterId,
	DEFAULT_CELLAR_FILTER,
} from "#/lib/drunk-wine/filter";
import { DRUNK_WINE_MAX_PAGE_SIZE } from "#/lib/drunk-wine/pagination";
import {
	buildWinePhotoKey,
	MAX_PHOTOS_PER_ENTRY,
	resolveStoredPhotoMime,
	thumbKeyForPhotoKey,
} from "#/lib/drunk-wine/photo";
import type {
	CreateDrunkWineInput,
	CreateWineTastingInput,
	UpdateDrunkWineInput,
	UpdateWineTastingInput,
} from "#/lib/drunk-wine/schema";
import { DEFAULT_WINE_STATUS, type WineStatus } from "#/lib/drunk-wine/status";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import { imagePathForKey } from "#/lib/images/signed-url";
import { logError } from "#/lib/logger";
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
	aopId: string | null;
	/** AOP紐付け時のみ。静的マスタから導出 */
	aopNameJa: string | null;
	regionId: RegionId | null;
	/** 最新の飲用記録の評価。飲用記録が無い/未入力なら null */
	lastRating: number | null;
	/** 最新の飲用記録のメモ。飲用記録が無い/未入力なら null */
	lastMemo: string | null;
	vintage: number | null;
	grapeVarietyIds: string[];
	producer: string | null;
	price: number | null;
	/** 写真の相対URL(/api/images/...)の配列。表示順で先頭=代表。呼び出し側で必要なら絶対化する */
	photoUrls: string[];
	/**
	 * 一覧表示用サムネイルの相対URL(photoUrls と同じ順・同じ長さ)。キーは原寸から
	 * 導出する(#237)。サムネイルが未保存の写真(MCP経由・本機能より前の写真)でも、
	 * 配信ルートが原寸へフォールバックするのでそのまま使える。
	 */
	thumbUrls: string[];
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

/**
 * エントリ1件を組み立てるのに必要な行。drunk_wine の列に、最新の飲用記録から
 * 導出した評価・メモを足したもの(列としては持たない。selectEntry 参照)。
 */
type DrunkWineRow = typeof drunkWine.$inferSelect & {
	lastRating: number | null;
	lastMemo: string | null;
};
type WineTastingRow = typeof wineTasting.$inferSelect;

function toEntry(row: DrunkWineRow): DrunkWineEntry {
	const aop = row.aopId ? getAop(row.aopId) : undefined;
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		lastDrankOn: row.lastDrankOn,
		tastingCount: row.tastingCount,
		aopId: row.aopId,
		aopNameJa: aop?.nameJa ?? null,
		regionId: aop?.region ?? null,
		lastRating: row.lastRating,
		lastMemo: row.lastMemo,
		vintage: row.vintage,
		grapeVarietyIds: row.grapeVarietyIds,
		producer: row.producer,
		price: row.price,
		photoUrls: row.photoKeys.map(imagePathForKey),
		thumbUrls: row.photoKeys.map((key) =>
			imagePathForKey(thumbKeyForPhotoKey(key)),
		),
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
 *  「max(drank_on)」が常に一致する。相関サブクエリ内では下記のエイリアスで修飾する。 */
const LATEST_TASTING_ORDER = sql`order by t.drank_on is null, t.drank_on desc, t.created_at desc`;

/**
 * 最新の飲用記録の1列を引く相関サブクエリ。
 *
 * **テーブル修飾を自前で書く必要がある**。drizzle は SELECT の `sql` テンプレート内で
 * 列参照をテーブル名なし(`"rating"`, `"id"`)に描画するため、そのまま書くと内側の
 * wine_tasting と外側の drunk_wine で同名列(`id`)が衝突し、SQLite は内側スコープを
 * 優先して `wine_tasting.drunk_wine_id = wine_tasting.id` という常に偽の条件になる
 * (静かに null が返るだけでエラーにならない)。UPDATE の SET 内では逆に完全修飾で
 * 描画されるため、同じ式でも文脈によって意味が変わる。エイリアス `t` と
 * `"drunk_wine".id` で明示すれば、どちらの文脈でも正しく相関する。
 */
function latestTastingValue<T extends number | string>(
	column: typeof wineTasting.rating | typeof wineTasting.memo,
) {
	return sql<T | null>`(select t.${sql.raw(column.name)} from ${wineTasting} t where t.drunk_wine_id = ${drunkWine}.id ${LATEST_TASTING_ORDER} limit 1)`;
}

const TASTING_COUNT_EXPR = sql`(select count(*) from ${wineTasting} where ${wineTasting.drunkWineId} = ${drunkWine.id})`;
const MAX_DRANK_ON_EXPR = sql`(select max(${wineTasting.drankOn}) from ${wineTasting} where ${wineTasting.drunkWineId} = ${drunkWine.id})`;

/**
 * 飲用記録から集計キャッシュを再計算する UPDATE を組み立てる(実行はしない。
 * 呼び出し側が db.batch に積む)。
 *
 * 非正規化して持つのは last_drank_on(MAX)と tasting_count(COUNT)だけ。評価・メモは
 * 「最新1件の値」なので集計ではなく、読み取り時に selectEntry の相関サブクエリで
 * 導出する(#205)。旧 drank_on/rating/memo への二重書きはここから外した。
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
			...(extra?.status ? { status: extra.status } : {}),
		})
		.where(and(eq(drunkWine.id, drunkWineId), eq(drunkWine.userId, userId)));
}

/**
 * エントリを読み直す SELECT。最新の飲用記録の評価・メモを相関サブクエリで載せる。
 *
 * 列を増やして非正規化する案も採れるが、そうすると「最新1件の射影」を書き戻す
 * 経路がまた増え、#205 で消したはずの二重管理が名前を変えて戻ってくる。
 * (drunk_wine_id, drank_on) の複合インデックスが効くので、相関サブクエリでも
 * 1行あたりインデックス参照2回で済む。
 *
 * 変更系は db.batch の最後にこれを積んで最終状態を得る(UPDATE の RETURNING では
 * サブクエリを使えないため)。
 */
function selectEntry(userId: string, id: string) {
	return db
		.select({
			...getTableColumns(drunkWine),
			lastRating: latestTastingValue<number>(wineTasting.rating),
			lastMemo: latestTastingValue<string>(wineTasting.memo),
		})
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
}

/** db.batch の結果末尾(selectEntry)から1件取り出す。無ければ NotFound。 */
function entryFromBatch(results: unknown[]): DrunkWineEntry {
	const row = (results.at(-1) as DrunkWineRow[] | undefined)?.[0];
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
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
		// 飲用記録が無いので最新1件も無い。読み直さずに null で組み立てる。
		return toEntry({ ...row, lastRating: null, lastMemo: null });
	}

	// 銘柄と飲用記録を1トランザクションで作る(写真と違いR2キーの物理制約が無い)。
	// 最後の SELECT から最終状態を得る。
	return entryFromBatch(
		await db.batch([
			db.insert(drunkWine).values(values),
			db.insert(wineTasting).values(buildTastingValues(userId, id, tasting)),
			recomputeDrunkWineAggregates(userId, id),
			selectEntry(userId, id),
		]),
	);
}

export async function updateDrunkWine(
	userId: string,
	input: UpdateDrunkWineInput,
): Promise<DrunkWineEntry> {
	assertValidRefs(input);
	const { id, ...patch } = input;
	// undefined = 変更しない / null = クリア。undefinedキーはdrizzleが無視する
	// 存在しない/他ユーザ所有は SELECT が0件になり、区別せず同じエラーになる
	// (存在の探索を防ぐ)。
	return entryFromBatch(
		await db.batch([
			db
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
				.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId))),
			selectEntry(userId, id),
		]),
	);
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
	return entryFromBatch(
		await db.batch([
			db
				.insert(wineTasting)
				.values(buildTastingValues(userId, drunkWineId, input)),
			recomputeDrunkWineAggregates(userId, drunkWineId),
			selectEntry(userId, drunkWineId),
		]),
	);
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
	const read = selectEntry(userId, target.drunkWineId);
	return entryFromBatch(
		await db.batch(update ? [update, recompute, read] : [recompute, read]),
	);
}

export async function deleteWineTasting(
	userId: string,
	tastingId: string,
): Promise<DrunkWineEntry> {
	const target = await findOwnedTasting(userId, tastingId);
	return entryFromBatch(
		await db.batch([
			db
				.delete(wineTasting)
				.where(
					and(eq(wineTasting.id, tastingId), eq(wineTasting.userId, userId)),
				),
			recomputeDrunkWineAggregates(userId, target.drunkWineId),
			selectEntry(userId, target.drunkWineId),
		]),
	);
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
	return entryFromBatch(
		await db.batch([
			db
				.insert(wineTasting)
				.values(buildTastingValues(userId, drunkWineId, tasting)),
			recomputeDrunkWineAggregates(userId, drunkWineId, { status: "finished" }),
			selectEntry(userId, drunkWineId),
		]),
	);
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
	const read = selectEntry(userId, drunkWineId);
	return entryFromBatch(
		await db.batch(update ? [update, recompute, read] : [recompute, read]),
	);
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
	// R2は複数キー一括削除に対応(存在しないキーは無視される)。サムネイル(#237)も一緒に消す。
	if (row.photoKeys.length > 0) {
		await env.AVATARS.delete([
			...row.photoKeys,
			...row.photoKeys.map(thumbKeyForPhotoKey),
		]);
	}
}

export interface ListDrunkWinesOptions {
	/** 絞り込み条件(一覧のチップと同じ定義)。既定は "all"。 */
	filter?: CellarFilterId;
	/** 1ページの件数。未指定なら全件返す(地図のように全ピンが要る経路のため)。 */
	limit?: number;
	/** 前ページの nextCursor。先頭ページは未指定。 */
	cursor?: string | null;
}

export interface ListDrunkWinesPage {
	entries: DrunkWineEntry[];
	/** 次ページがあればそのカーソル。無ければ null。 */
	nextCursor: string | null;
}

// カーソルは "createdAt(ms):id"。createdAt だけだと同一ミリ秒の登録で行が飛ぶ/重複する
// ため id をタイブレーカにする(id は主キーなので一意)。並び順も同じ2キーで固定する。
function encodeCursor(entry: DrunkWineEntry): string {
	return `${entry.createdAt}:${entry.id}`;
}

function decodeCursor(
	cursor: string,
): { createdAt: number; id: string } | null {
	const sep = cursor.indexOf(":");
	if (sep <= 0) return null;
	const createdAt = Number(cursor.slice(0, sep));
	const id = cursor.slice(sep + 1);
	if (!Number.isFinite(createdAt) || !id) return null;
	return { createdAt, id };
}

/**
 * 一覧の絞り込みを SQL 条件に落とす。判定の定義は #/lib/drunk-wine/filter の
 * matchesCellarFilter が単一情報源で、ここはその SQL 版。
 * **両者が一致することは drunk-wine-service.workers.test.ts が実データで突合する**
 * (条件を片方だけ変えると、一覧の件数と中身が食い違う)。
 */
function cellarFilterCondition(filter: CellarFilterId) {
	switch (filter) {
		case "all":
			return undefined;
		case "tasted":
			return sql`${drunkWine.tastingCount} > 0`;
		case "owned":
			return eq(drunkWine.status, "owned");
		case "wishlist":
			return eq(drunkWine.status, "wishlist");
	}
}

/**
 * マイセラーの一覧。新しい順(createdAt 降順)。
 *
 * limit を渡すとカーソルページネーションになる(#254)。マイセラーはユーザが単調に
 * 増やすデータで上限が無く、全件取得だと行スキャン・レスポンスサイズ・MCP の
 * トークン消費が件数に線形で悪化するため。並び順とカーソルは
 * `drunk_wine_user_created_idx`(user_id, created_at) をそのまま使える形にしてある。
 *
 * limit 未指定の全件取得も残している。地図(/cellar/map)は全ピンを一度に描くので
 * ページ単位では成立しないため。
 */
export async function listDrunkWines(
	userId: string,
	options: ListDrunkWinesOptions = {},
): Promise<ListDrunkWinesPage> {
	const filter = options.filter ?? DEFAULT_CELLAR_FILTER;
	const limit =
		options.limit == null
			? null
			: Math.min(
					Math.max(1, Math.trunc(options.limit)),
					DRUNK_WINE_MAX_PAGE_SIZE,
				);
	const after = options.cursor ? decodeCursor(options.cursor) : null;

	const conditions = [eq(drunkWine.userId, userId)];
	const filterCondition = cellarFilterCondition(filter);
	if (filterCondition) conditions.push(filterCondition);
	if (after) {
		// keyset: (created_at, id) の辞書順で「カーソルより古い」行だけを読む
		conditions.push(
			sql`(${drunkWine.createdAt} < ${after.createdAt} OR (${drunkWine.createdAt} = ${after.createdAt} AND ${drunkWine.id} < ${after.id}))`,
		);
	}

	const query = db
		.select({
			...getTableColumns(drunkWine),
			lastRating: latestTastingValue<number>(wineTasting.rating),
			lastMemo: latestTastingValue<string>(wineTasting.memo),
		})
		.from(drunkWine)
		.where(and(...conditions))
		.orderBy(desc(drunkWine.createdAt), desc(drunkWine.id));

	// +1件多く読んで「次があるか」を判定する(別途 COUNT を撃たない)
	const rows = await (limit == null ? query : query.limit(limit + 1));
	const entries = rows.map(toEntry);
	if (limit == null || entries.length <= limit) {
		return { entries, nextCursor: null };
	}
	const page = entries.slice(0, limit);
	const last = page[page.length - 1];
	return { entries: page, nextCursor: last ? encodeCursor(last) : null };
}

/**
 * 一覧チップの件数。ページネーションで手元に無い行も数える必要があるので、
 * 行を持たずに集計だけを1クエリで取る(#254)。
 * 数え方は countCellarFilters(純関数)と一致させる。
 */
export async function countCellarFilters(
	userId: string,
): Promise<Record<CellarFilterId, number>> {
	const [row] = await db
		.select({
			all: sql<number>`count(*)`,
			tasted: sql<number>`sum(case when ${drunkWine.tastingCount} > 0 then 1 else 0 end)`,
			owned: sql<number>`sum(case when ${drunkWine.status} = 'owned' then 1 else 0 end)`,
			wishlist: sql<number>`sum(case when ${drunkWine.status} = 'wishlist' then 1 else 0 end)`,
		})
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId));
	return {
		all: Number(row?.all ?? 0),
		tasted: Number(row?.tasted ?? 0),
		owned: Number(row?.owned ?? 0),
		wishlist: Number(row?.wishlist ?? 0),
	};
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
		.select({
			...getTableColumns(drunkWine),
			lastRating: latestTastingValue<number>(wineTasting.rating),
			lastMemo: latestTastingValue<string>(wineTasting.memo),
		})
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
	const [row] = await selectEntry(userId, id);
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row);
}

/** syncDrunkWinePhotos に渡す最終並び順の1要素。既存キーの保持か、新規バイト列の追加。 */
export type PhotoLayoutItem =
	| { kind: "existing"; key: string }
	| {
			kind: "new";
			bytes: Uint8Array | ArrayBuffer;
			mimeType: string;
			/**
			 * 一覧用サムネイル(JPEG)。ブラウザ側で生成して一緒に送る(#237)。
			 * 省略可(MCP 経由など生成できない経路)。無い場合は配信ルートが原寸へ
			 * フォールバックするので、機能としては成立する。
			 */
			thumbBytes?: Uint8Array | ArrayBuffer;
	  };

/**
 * 今回 put した R2 オブジェクトの巻き戻し。**補償の失敗で呼び出し元の結果を置き換えない**。
 *
 * 素で `await env.AVATARS.delete(...)` すると、R2 の一時障害時に delete のエラーが伝播して
 * 元の失敗(画像偽装拒否の BadRequestError など)を上書きし、400 が 500 に化ける。さらに
 * ログにも delete 失敗しか残らないため、真因(put 失敗か検証拒否か)が消えて調査が詰む。
 * #158 で refundReservationOnFailure に施したのと同じ「補償は包んでログし、元の結果を必ず
 * 通す」イディオムを揃える(#249)。
 */
async function rollbackPutKeys(
	keys: readonly string[],
	ctx: { userId: string; entryId: string; originalErr?: unknown },
): Promise<void> {
	if (keys.length === 0) return;
	try {
		await env.AVATARS.delete([...keys]);
	} catch (err) {
		logError("photo rollback failed", {
			userId: ctx.userId,
			entryId: ctx.entryId,
			keys,
			err,
			// 巻き戻しの契機になった元の失敗。これが消えると真因が追えない
			originalErr: ctx.originalErr,
		});
	}
}

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
			// サムネイルは原寸キーから導出したキーに置く。失敗しても原寸で表示できるので
			// 保存自体は必須にしない(ここで throw すると写真そのものが保存できなくなる)。
			if (item.thumbBytes) {
				const thumb =
					item.thumbBytes instanceof Uint8Array
						? item.thumbBytes
						: new Uint8Array(item.thumbBytes);
				// 送られてきたサムネイルも実バイトで検証する(原寸と同じ #150 の方針)。
				if (resolveStoredPhotoMime(thumb, "image/jpeg") === "image/jpeg") {
					const thumbKey = thumbKeyForPhotoKey(key);
					await env.AVATARS.put(thumbKey, thumb, {
						httpMetadata: { contentType: "image/jpeg" },
					});
					putKeys.push(thumbKey);
				}
			}
		}
	} catch (e) {
		// 巻き戻しの失敗で元の例外を置き換えない(#249)。素で await すると、R2 の一時障害時に
		// delete のエラーが伝播し、画像偽装拒否の BadRequestError(400) が 500 に化ける。
		await rollbackPutKeys(putKeys, { userId, entryId: id, originalErr: e });
		throw e;
	}

	const [row] = await db
		.update(drunkWine)
		.set({ photoKeys: nextKeys })
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning();
	// 存在確認とここまでの間にエントリが削除された場合、put分を掃除する。
	// ここも掃除の失敗で NotFoundError(404) を 500 に化けさせない(#249)。
	if (!row) {
		await rollbackPutKeys(putKeys, { userId, entryId: id });
		throw new NotFoundError("Entry not found");
	}

	// 旧配列にあって新配列に残らないキーを削除(削除・差し替え・並べ替えを一括反映)。
	// サムネイルは原寸に追随させる(消し忘れるとR2に孤児が残り続ける)。
	const nextSet = new Set(nextKeys);
	const removed = currentKeys.filter((key) => !nextSet.has(key));
	if (removed.length > 0) {
		await env.AVATARS.delete([...removed, ...removed.map(thumbKeyForPhotoKey)]);
	}

	// 写真の更新は飲用記録を変えないが、最新1件の評価・メモは列に持たないので
	// 返却用に読み直す(R2 の後始末が済んでから)。
	return getDrunkWine(userId, id);
}
