import { env } from "cloudflare:workers";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	drunkWine,
	importBatch,
	place,
	wineSighting,
	wineTasting,
} from "#/db/schema";
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
import { BadRequestError, ConflictError, NotFoundError } from "#/lib/errors";
import { imagePathForKey } from "#/lib/images/signed-url";
import type { BulkRegisterFromScanInput } from "#/lib/import-batch/schema";
import { type LogFields, logError, logInfo, logWarn } from "#/lib/logger";
import { DEFAULT_PLACE_KIND } from "#/lib/place/place";
import {
	type CreateWineSightingInput,
	MAX_PHOTOS_PER_IMPORT_BATCH,
	type UpdateWineSightingInput,
} from "#/lib/place/schema";
import { countryForRegion, getCountry } from "#/lib/wine/countries";
import {
	getAop,
	getRegion,
	getVariety,
	legacyAopIdsFor,
	resolveAopId,
} from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";

// マイセラーのサービス層。Webのserver fnとMCPツールの共通入口で、
// D1(drunk_wine / wine_tasting)とR2(写真)への薄い橋渡しに徹する。
// AOP・品種は静的マスタ参照(FKなし)のため、ここで存在検証する。
//
// 所有状態(status)と飲用履歴(wine_tasting)は直交する2軸で、互いに自動連動しない
// (Issue #195)。唯一の例外は「飲んだ」操作(markWineDrunk)で、飲用記録の追加と
// status='finished' を1操作としてここに閉じている。

/**
 * `inArray(...)` に積む id の1文あたりの上限。**件数が実行時に決まる経路は
 * すべてこの単位で分割する**(まとめ削除 #400 / 集計の一括再計算 #363)。
 *
 * D1 は1クエリのバインド変数を100個に制限しており、超えると
 * `too many SQL variables` でクエリごと失敗する。id に加えて所有権の userId も
 * 束縛するため「100件ちょうど」でも既に超える。余裕を見て 50 で割る。
 */
const ID_CHUNK_SIZE = 50;

export interface DrunkWineEntry {
	id: string;
	name: string;
	status: WineStatus;
	/** 最新の飲用記録の飲んだ日。飲用記録が無い/全件日付未入力なら null */
	lastDrankOn: string | null;
	/** 飲用記録の件数。0 なら「まだ飲んだことがない」 */
	tastingCount: number;
	/** 最新の目撃記録の見かけた日。目撃記録が無い/全件日付未入力なら null */
	lastSeenOn: string | null;
	/** 目撃記録の件数。0 なら「どこでも見かけていない」 */
	sightingCount: number;
	aopId: string | null;
	/** AOP紐付け時のみ。静的マスタから導出 */
	aopNameJa: string | null;
	/**
	 * 表示用の地域。AOP紐付けなら静的マスタから導出、地域紐付けなら保存値。
	 * どちらも無ければ null(国紐付けのみ・未紐付け)。
	 */
	regionId: RegionId | null;
	/**
	 * 表示用の国。AOP/地域から導出、国紐付けなら保存値。無ければ null。
	 * 保存上は「最も細かい1つだけ」の排他(aopId ⊃ regionId ⊃ countryId)。
	 */
	countryId: string | null;
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

export interface WineSightingEntry {
	id: string;
	placeId: string | null;
	/** 場所の表示名。placeId が無い/場所が消された場合は null */
	placeName: string | null;
	batchId: string | null;
	photoIndex: number | null;
	/**
	 * 見かけたときの写真(一括登録のバッチ写真)の相対URL。手で足した目撃記録や、
	 * 写真の保存に失敗したバッチでは null。
	 */
	photoUrl: string | null;
	seenOn: string | null;
	price: number | null;
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
/**
 * 目撃記録の行に、表示用の場所名と由来バッチの写真キー配列(いずれも LEFT JOIN で
 * 引く)を足したもの。写真は「バッチの photoKeys の photoIndex 番目」なので、
 * 行だけでは URL を組み立てられない。
 */
type WineSightingRow = typeof wineSighting.$inferSelect & {
	placeName: string | null;
	batchPhotoKeys: string[] | null;
};

function toEntry(row: DrunkWineRow): DrunkWineEntry {
	const aop = row.aopId ? getAop(row.aopId) : undefined;
	if (row.aopId && !aop) {
		// 静的マスタから消えた ID を参照している行(#333)。ID の削除・改名は
		// data-integrity.test.ts の台帳チェックが CI で止めるので通常は発生しないが、
		// すり抜けた場合に「地図から静かに消える」だけで終わらないよう検出可能にする。
		// `bun run logs --grep "orphan aop_id"` で棚卸しできる。
		logWarn("orphan aop_id", { drunkWineId: row.id, aopId: row.aopId });
	}
	// 地域・国は細→粗へ導出する(AOPがあればその地域、地域があればその国)。
	// 保存値が静的マスタから消えた場合も aop_id と同様に検出可能にする(#333 と同型)。
	const storedRegion =
		!aop && row.regionId ? getRegion(row.regionId) : undefined;
	if (!aop && row.regionId && !storedRegion) {
		logWarn("orphan region_id", {
			drunkWineId: row.id,
			regionId: row.regionId,
		});
	}
	const region = aop ? getRegion(aop.region) : storedRegion;
	const derivedCountry = region ? countryForRegion(region) : undefined;
	const storedCountry =
		!region && row.countryId ? getCountry(row.countryId) : undefined;
	if (!region && row.countryId && !storedCountry) {
		logWarn("orphan country_id", {
			drunkWineId: row.id,
			countryId: row.countryId,
		});
	}
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		lastDrankOn: row.lastDrankOn,
		tastingCount: row.tastingCount,
		lastSeenOn: row.lastSeenOn,
		sightingCount: row.sightingCount,
		// 退役ID(改名前のスラッグ)で保存された行も、現行IDとして返す。地図のハイライトや
		// AOP ページへのリンクが現行のマスタと突き合わせられるようにするため。
		aopId: aop?.id ?? row.aopId,
		aopNameJa: aop?.nameJa ?? null,
		regionId: aop?.region ?? storedRegion?.id ?? null,
		countryId: derivedCountry?.id ?? storedCountry?.id ?? null,
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

function toSightingEntry(row: WineSightingRow): WineSightingEntry {
	// 由来写真は「バッチの photoKeys の photoIndex 番目」。バッチが無い(手で足した
	// 目撃記録)・写真をまだ保存していない・番号が範囲外のいずれでも null にする
	// (存在しないキーの URL を作るとリンク切れの画像が並ぶ)。
	const photoKey =
		row.photoIndex != null ? row.batchPhotoKeys?.[row.photoIndex] : undefined;
	return {
		id: row.id,
		placeId: row.placeId,
		placeName: row.placeName,
		batchId: row.batchId,
		photoIndex: row.photoIndex,
		photoUrl: photoKey ? imagePathForKey(photoKey) : null,
		seenOn: row.seenOn,
		price: row.price,
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
const SIGHTING_COUNT_EXPR = sql`(select count(*) from ${wineSighting} where ${wineSighting.drunkWineId} = ${drunkWine.id})`;
const MAX_SEEN_ON_EXPR = sql`(select max(${wineSighting.seenOn}) from ${wineSighting} where ${wineSighting.drunkWineId} = ${drunkWine.id})`;

/**
 * 飲用記録・目撃記録から集計キャッシュを再計算する UPDATE を組み立てる(実行はしない。
 * 呼び出し側が db.batch に積む)。
 *
 * 非正規化して持つのは MAX と COUNT だけ(last_drank_on / tasting_count と
 * last_seen_on / sighting_count)。評価・メモは「最新1件の値」なので集計ではなく、
 * 読み取り時に selectEntry の相関サブクエリで導出する(#205)。
 *
 * **飲用側だけ・目撃側だけを触る経路でも4列すべてを再計算する**。片方だけ更新する
 * 変種を作ると「どの経路がどの列を保証するか」を呼び出し側が覚える必要が生まれ、
 * 経路が増えるたびに漏れる(#177 / #185 と同じ類型)。全再計算は冪等なので、
 * 関係ない列は同じ値で書き戻されるだけで害がない。
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
			sightingCount: SIGHTING_COUNT_EXPR,
			lastSeenOn: MAX_SEEN_ON_EXPR,
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
	regionId?: string | null;
	countryId?: string | null;
	grapeVarietyIds?: string[];
}) {
	if (input.aopId && !getAop(input.aopId)) {
		throw new BadRequestError(`Unknown AOP: ${input.aopId}`);
	}
	if (input.regionId && !getRegion(input.regionId)) {
		throw new BadRequestError(`Unknown region: ${input.regionId}`);
	}
	if (input.countryId && !getCountry(input.countryId)) {
		throw new BadRequestError(`Unknown country: ${input.countryId}`);
	}
	for (const id of input.grapeVarietyIds ?? []) {
		if (!getVariety(id)) {
			throw new BadRequestError(`Unknown grape variety: ${id}`);
		}
	}
}

/**
 * 産地紐付けの排他(「最も細かい1つだけを保存する」)の正規化。
 *
 * 3列(aop_id / region_id / country_id)を独立に持たせると「AOPはシャブリなのに
 * 地域はボルドー」のような矛盾を表現できてしまうため、書き込み時にここで畳む。
 * 読み取り(toEntry)は細→粗へ導出するので、粗い列に重複して保存する必要はない。
 */

/** 作成用: 入力の最も細かい単位だけを残した3列を返す。 */
function provenanceInsertValues(input: {
	aopId?: string | null;
	regionId?: string | null;
	countryId?: string | null;
}): {
	aopId: string | null;
	regionId: string | null;
	countryId: string | null;
} {
	if (input.aopId) {
		// 退役IDで送られてきた場合は現行IDへ正規化して保存する(#333)
		return {
			aopId: resolveAopId(input.aopId) ?? input.aopId,
			regionId: null,
			countryId: null,
		};
	}
	if (input.regionId) {
		return { aopId: null, regionId: input.regionId, countryId: null };
	}
	if (input.countryId) {
		return { aopId: null, regionId: null, countryId: input.countryId };
	}
	return { aopId: null, regionId: null, countryId: null };
}

/**
 * 更新用: いずれかの単位が文字列で指定されたら「その粒度を選んだ」とみなし、
 * 他の2列をクリアする。全て未指定(undefined)なら3列とも変更しない。
 * null(クリア)だけの指定はそのまま通す(フォームは紐付け解除時に該当列へ null を送る)。
 */
function provenanceUpdateValues(patch: {
	aopId?: string | null;
	regionId?: string | null;
	countryId?: string | null;
}): {
	aopId?: string | null;
	regionId?: string | null;
	countryId?: string | null;
} {
	if (typeof patch.aopId === "string") {
		return {
			aopId: resolveAopId(patch.aopId) ?? patch.aopId,
			regionId: null,
			countryId: null,
		};
	}
	if (typeof patch.regionId === "string") {
		return { aopId: null, regionId: patch.regionId, countryId: null };
	}
	if (typeof patch.countryId === "string") {
		return { aopId: null, regionId: null, countryId: patch.countryId };
	}
	return {
		aopId: patch.aopId,
		regionId: patch.regionId,
		countryId: patch.countryId,
	};
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
		...provenanceInsertValues(input),
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
					...provenanceUpdateValues(patch),
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
	/** 一括登録由来の場合のバッチID。手動追加は未指定(null)(#393)。 */
	batchId: string | null = null,
) {
	return {
		id: crypto.randomUUID(),
		drunkWineId,
		userId,
		batchId,
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

// ---- 目撃記録 -------------------------------------------------------------
// 飲用記録と同じ形(所有権確認 → 変更文 + 集計再計算 + 読み直しを1つの db.batch)。
// 別ファイルに切らずここに置くのは、recomputeDrunkWineAggregates / selectEntry /
// entryFromBatch といったモジュール私有のヘルパと同じ batch に積む必要があるため。

/**
 * placeId / batchId は FK があるだけでは他ユーザの行も指せてしまう(FK は所有者を
 * 見ない)。他人の place を指した目撃記録を作れると、一覧の placeName に他人の
 * 店名が出て情報が漏れる。参照する前に必ず所有権を確認する。
 *
 * 存在しない/他ユーザは区別せず同一エラー(存在の探索を防ぐ規約)。
 */
async function assertOwnsSightingRefs(
	userId: string,
	refs: { placeId?: string | null; batchId?: string | null },
): Promise<void> {
	if (refs.placeId) {
		const [row] = await db
			.select({ id: place.id })
			.from(place)
			.where(and(eq(place.id, refs.placeId), eq(place.userId, userId)));
		if (!row) throw new NotFoundError("Place not found");
	}
	if (refs.batchId) {
		const [row] = await db
			.select({ id: importBatch.id })
			.from(importBatch)
			.where(
				and(eq(importBatch.id, refs.batchId), eq(importBatch.userId, userId)),
			);
		if (!row) throw new NotFoundError("Import batch not found");
	}
}

function buildSightingValues(
	userId: string,
	drunkWineId: string,
	input: CreateWineSightingInput,
) {
	return {
		id: crypto.randomUUID(),
		drunkWineId,
		userId,
		placeId: input.placeId ?? null,
		batchId: input.batchId ?? null,
		photoIndex: input.photoIndex ?? null,
		seenOn: input.seenOn ?? null,
		price: input.price ?? null,
		memo: input.memo ?? null,
	};
}

/**
 * 目撃記録の一覧。見かけた日の新しい順で、日付未入力は末尾(飲用記録の並びと同じ規約)。
 * 場所名は LEFT JOIN で引く — place が消えていても目撃した事実は残るので、
 * INNER JOIN にすると記録が一覧から消える。
 */
export async function listWineSightings(
	userId: string,
	drunkWineId: string,
): Promise<WineSightingEntry[]> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	const rows = await db
		.select({
			...getTableColumns(wineSighting),
			placeName: place.name,
			batchPhotoKeys: importBatch.photoKeys,
		})
		.from(wineSighting)
		.leftJoin(place, eq(place.id, wineSighting.placeId))
		.leftJoin(importBatch, eq(importBatch.id, wineSighting.batchId))
		.where(
			and(
				eq(wineSighting.drunkWineId, drunkWineId),
				eq(wineSighting.userId, userId),
			),
		)
		.orderBy(
			sql`${wineSighting.seenOn} is null`,
			desc(wineSighting.seenOn),
			desc(wineSighting.createdAt),
		);
	return rows.map(toSightingEntry);
}

export async function addWineSighting(
	userId: string,
	drunkWineId: string,
	input: CreateWineSightingInput,
): Promise<DrunkWineEntry> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	await assertOwnsSightingRefs(userId, input);
	return entryFromBatch(
		await db.batch([
			db
				.insert(wineSighting)
				.values(buildSightingValues(userId, drunkWineId, input)),
			recomputeDrunkWineAggregates(userId, drunkWineId),
			selectEntry(userId, drunkWineId),
		]),
	);
}

/** 所有する目撃記録を引く。存在しない/他ユーザは同一エラー。 */
async function findOwnedSighting(userId: string, sightingId: string) {
	const [row] = await db
		.select({
			id: wineSighting.id,
			drunkWineId: wineSighting.drunkWineId,
		})
		.from(wineSighting)
		.where(
			and(eq(wineSighting.id, sightingId), eq(wineSighting.userId, userId)),
		);
	if (!row) throw new NotFoundError("Entry not found");
	return row;
}

/**
 * 目撃記録1件を更新する文を組み立てる。全キーが未指定なら null を返す
 * (drizzle は空の SET を "No values to set" で拒否するため)。集計の再計算だけは
 * 呼び出し側が常に実行する — 冪等なので、整合が崩れたときの復旧手段になる。
 */
function buildSightingUpdate(
	userId: string,
	sightingId: string,
	patch: Omit<UpdateWineSightingInput, "id">,
) {
	// undefined = 変更しない / null = クリア。undefinedキーはdrizzleが無視する
	if (Object.values(patch).every((v) => v === undefined)) return null;
	return db
		.update(wineSighting)
		.set({
			placeId: patch.placeId,
			batchId: patch.batchId,
			photoIndex: patch.photoIndex,
			seenOn: patch.seenOn,
			price: patch.price,
			memo: patch.memo,
		})
		.where(
			and(eq(wineSighting.id, sightingId), eq(wineSighting.userId, userId)),
		);
}

export async function updateWineSighting(
	userId: string,
	input: UpdateWineSightingInput,
): Promise<DrunkWineEntry> {
	const { id, ...patch } = input;
	const target = await findOwnedSighting(userId, id);
	await assertOwnsSightingRefs(userId, patch);
	const update = buildSightingUpdate(userId, id, patch);
	const recompute = recomputeDrunkWineAggregates(userId, target.drunkWineId);
	const read = selectEntry(userId, target.drunkWineId);
	return entryFromBatch(
		await db.batch(update ? [update, recompute, read] : [recompute, read]),
	);
}

export async function deleteWineSighting(
	userId: string,
	sightingId: string,
): Promise<DrunkWineEntry> {
	const target = await findOwnedSighting(userId, sightingId);
	return entryFromBatch(
		await db.batch([
			db
				.delete(wineSighting)
				.where(
					and(eq(wineSighting.id, sightingId), eq(wineSighting.userId, userId)),
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

/**
 * 写真の R2 後始末は **best-effort**。失敗しても呼び出し元へ伝播させず、ログだけ残す(#249)。
 *
 * 巻き戻し(補償)経路で `delete` の例外をそのまま投げると、**元の失敗を置き換えてしまう**。
 * 画像偽装拒否の BadRequestError(400)が R2 の一時障害で 500 に化け、ログにも delete の
 * 失敗しか残らないため、真因(put 失敗か検証拒否か)が追えなくなる。#158 で
 * `refundReservationOnFailure` に入れた「補償失敗はログして元例外を通す」形をここにも適用する。
 *
 * 置換完了後の孤児掃除も同じ扱いにする。D1 の photo_keys は既に更新済みで、そちらが
 * 正となる状態のため、R2 に残骸が残ることより「成功した更新を失敗として返す」ほうが害が大きい。
 */
// R2 delete は1回あたり最大1000キー。まとめて渡すとAPI呼び出しが失敗するため、
// 一括削除(deleteDrunkWines)で複数エントリぶんの写真+サムネイルを渡すケースに備えて
// ここでチャンク分割する(単体削除は常に1チャンクで収まるため挙動は変わらない)。
const R2_DELETE_CHUNK_SIZE = 1000;

async function cleanupPhotoObjects(
	keys: string[],
	fields: LogFields & { userId: string; entryId: string; phase: string },
): Promise<void> {
	if (keys.length === 0) return;
	for (let i = 0; i < keys.length; i += R2_DELETE_CHUNK_SIZE) {
		const chunk = keys.slice(i, i + R2_DELETE_CHUNK_SIZE);
		try {
			await env.AVATARS.delete(chunk);
		} catch (cleanupErr) {
			logError("photo cleanup failed", {
				...fields,
				keys: chunk,
				err: cleanupErr,
			});
		}
	}
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
	// D1の行は既に消えているので、掃除の失敗で「削除できなかった」と返さない(#249)。
	await cleanupPhotoObjects(
		row.photoKeys.length > 0
			? [...row.photoKeys, ...row.photoKeys.map(thumbKeyForPhotoKey)]
			: [],
		{ userId, entryId: id, phase: "entry-deleted" },
	);
}

/**
 * 複数エントリのまとめ削除(Issue #363 案B: /cellar 一覧のチェックボックス選択)。
 * 所有権を持たない/存在しない id は黙って無視し(単体削除の Entry not found とは違い、
 * 選択リストに他ユーザの id が混ざることは無いため、部分一致でも呼び出し側のミスとは
 * 見なさない)、実際に消えた件数を返す。
 *
 * D1書き込みは `drunk_wine` 1テーブルへの delete のみで、`wine_tasting` /
 * `wine_sighting` は ON DELETE CASCADE(schema.ts)で連動して消える。写真は
 * エントリ横断でまとめて1回(チャンク分割込み)のR2一括削除にする。
 *
 * **id は ID_CHUNK_SIZE 件ずつの delete に割り、1つの db.batch にまとめて積む**
 * (Issue #400)。一覧の「すべて選択」は読み込み済みの全件を選ぶので、1文に
 * 収まらない件数が実際に来る。分割しないと D1 のバインド変数上限
 * (1クエリ100個。id 100個 + 所有権の userId で既に超える)でクエリごと失敗した。
 * db.batch は1トランザクションなので、分割しても「全部消えるか何も消えないか」は
 * 変わらない。
 */
export async function deleteDrunkWines(
	userId: string,
	ids: string[],
): Promise<{ deletedCount: number }> {
	// 重複は1文の中では潰れるが、チャンクをまたぐと2回目の delete が0件になるだけで
	// 実害は無い。とはいえ上限判定と分割数が無駄に増えるので先に畳んでおく。
	const uniqueIds = [...new Set(ids)];
	if (uniqueIds.length === 0) return { deletedCount: 0 };
	const statements: BatchStatement[] = [];
	for (let i = 0; i < uniqueIds.length; i += ID_CHUNK_SIZE) {
		statements.push(
			db
				.delete(drunkWine)
				.where(
					and(
						inArray(drunkWine.id, uniqueIds.slice(i, i + ID_CHUNK_SIZE)),
						eq(drunkWine.userId, userId),
					),
				)
				.returning({ photoKeys: drunkWine.photoKeys }),
		);
	}
	const rows = (
		await db.batch(statements as [BatchStatement, ...BatchStatement[]])
	).flat() as { photoKeys: string[] }[];
	const keys = rows.flatMap((row) =>
		row.photoKeys.length > 0
			? [...row.photoKeys, ...row.photoKeys.map(thumbKeyForPhotoKey)]
			: [],
	);
	await cleanupPhotoObjects(keys, {
		userId,
		entryId: ids.join(","),
		phase: "entries-deleted",
	});
	// 破壊的な一括削除の監査ライン(#394)。D1(cascade 込み)とR2にまたがる不可逆の
	// 操作なので、成功も1行残す。これが無いと「エントリが消えた」という問い合わせに
	// 対して「ユーザが消した / バグで消えた / そもそも無かった」を Workers Logs から
	// 区別できない。requested と deleted の差は所有権で弾かれた id の数でもある。
	logInfo("drunk wines bulk deleted", {
		userId,
		requestedCount: uniqueIds.length,
		deletedCount: rows.length,
		photoKeyCount: keys.length,
	});
	return { deletedCount: rows.length };
}

export interface ListDrunkWinesOptions {
	/** 絞り込み条件(一覧のチップと同じ定義)。既定は "all"。 */
	filter?: CellarFilterId;
	/**
	 * 場所での絞り込み(その場所で見かけた銘柄だけ)。チップ(所有状態)とは
	 * **直交する別の軸**なので、CellarFilterId には混ぜない——「セラーにある」かつ
	 * 「この店で見かけた」のような組み合わせが成立するため。
	 */
	placeId?: string;
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
		case "spotted":
			return eq(drunkWine.status, "spotted");
	}
}

/**
 * 「その場所で見かけた銘柄」の条件。目撃記録は 1:N なので EXISTS で畳む
 * (JOIN すると同じ場所で複数回見かけた銘柄が重複行になり、ページングの件数が狂う)。
 *
 * pure 版の対応物は置かない。所有状態のチップ(filter.ts)と違い、この軸は
 * wine_sighting を読まないと判定できず、クライアント側に同じ述語を置く用途が無い。
 */
function placeCondition(placeId: string) {
	return sql`exists (select 1 from ${wineSighting} where ${wineSighting.drunkWineId} = ${drunkWine.id} and ${wineSighting.placeId} = ${placeId})`;
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
	if (options.placeId) conditions.push(placeCondition(options.placeId));
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
 * あるAOPに紐付いた、そのユーザのマイセラー登録を新しい順に引く。地図の情報パネル
 * (AopDetailPanel)の「マイセラー」欄が使う。
 *
 * 絞り込みは aop_id の**完全一致**のみで、階層のロールアップはしない(畑を紐付けた
 * ワインを親の村名AOCのパネルには出さない)。パネルに出る集合が、そのワインの編集
 * 画面で選んだAOPと常に一対一で対応するほうが「どこに出るのか」を説明しやすく、
 * 参考リンク欄(aop_reference_link)のスコープとも揃うため。
 *
 * (user_id, aop_id) の索引は張らない。既存の drunk_wine_user_created_idx の user_id
 * 前方一致で当該ユーザの行だけに絞れ、マイセラーは1ユーザあたり高々数百行の規模だから。
 */
export async function listDrunkWinesByAop(
	userId: string,
	aopId: string,
): Promise<DrunkWineEntry[]> {
	const rows = await db
		.select({
			...getTableColumns(drunkWine),
			lastRating: latestTastingValue<number>(wineTasting.rating),
			lastMemo: latestTastingValue<string>(wineTasting.memo),
		})
		.from(drunkWine)
		.where(
			and(
				eq(drunkWine.userId, userId),
				// 改名前のIDで保存された行も同じ AOP のものとして拾う(#333)
				inArray(drunkWine.aopId, [aopId, ...legacyAopIdsFor(aopId)]),
			),
		)
		.orderBy(desc(drunkWine.createdAt), desc(drunkWine.id));
	return rows.map(toEntry);
}

/**
 * 一覧チップの件数。ページネーションで手元に無い行も数える必要があるので、
 * 行を持たずに集計だけを1クエリで取る(#254)。
 * 数え方は countCellarFilters(純関数)と一致させる。
 */
export async function countCellarFilters(
	userId: string,
	options: { placeId?: string } = {},
): Promise<Record<CellarFilterId, number>> {
	// 場所で絞り込んでいるときはチップの件数も同じ母集合で数える。ここを全件のまま
	// にすると、チップの数字と実際に並ぶ件数が食い違う。
	const conditions = [eq(drunkWine.userId, userId)];
	if (options.placeId) conditions.push(placeCondition(options.placeId));
	const [row] = await db
		.select({
			all: sql<number>`count(*)`,
			tasted: sql<number>`sum(case when ${drunkWine.tastingCount} > 0 then 1 else 0 end)`,
			owned: sql<number>`sum(case when ${drunkWine.status} = 'owned' then 1 else 0 end)`,
			wishlist: sql<number>`sum(case when ${drunkWine.status} = 'wishlist' then 1 else 0 end)`,
			spotted: sql<number>`sum(case when ${drunkWine.status} = 'spotted' then 1 else 0 end)`,
		})
		.from(drunkWine)
		.where(and(...conditions));
	return {
		all: Number(row?.all ?? 0),
		tasted: Number(row?.tasted ?? 0),
		owned: Number(row?.owned ?? 0),
		wishlist: Number(row?.wishlist ?? 0),
		spotted: Number(row?.spotted ?? 0),
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
		// 巻き戻しの成否に関わらず元例外を投げる(掃除の失敗で真因を隠さない)。
		await cleanupPhotoObjects(putKeys, {
			userId,
			entryId: id,
			phase: "rollback",
			originalErr: e,
		});
		throw e;
	}

	const [row] = await db
		.update(drunkWine)
		.set({ photoKeys: nextKeys })
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
		.returning();
	// 存在確認とここまでの間にエントリが削除された場合、put分を掃除する
	if (!row) {
		await cleanupPhotoObjects(putKeys, {
			userId,
			entryId: id,
			phase: "entry-deleted",
		});
		throw new NotFoundError("Entry not found");
	}

	// 旧配列にあって新配列に残らないキーを削除(削除・差し替え・並べ替えを一括反映)。
	// サムネイルは原寸に追随させる(消し忘れるとR2に孤児が残り続ける)。
	const nextSet = new Set(nextKeys);
	const removed = currentKeys.filter((key) => !nextSet.has(key));
	await cleanupPhotoObjects(
		removed.length > 0 ? [...removed, ...removed.map(thumbKeyForPhotoKey)] : [],
		{ userId, entryId: id, phase: "orphan-sweep" },
	);

	// 写真の更新は飲用記録を変えないが、最新1件の評価・メモは列に持たないので
	// 返却用に読み直す(R2 の後始末が済んでから)。
	return getDrunkWine(userId, id);
}

// ---- 一括登録(写真からのスキャン。Issue #358) -----------------------------
// レストランのワインリスト・ショップの棚を撮った写真から抽出した複数銘柄を、
// 1回の確定でまとめて登録する経路。場所(新規なら)・バッチ・銘柄・目撃記録・
// 飲用記録・集計キャッシュを**すべて同一の db.batch で原子的に**作る。
//
// ここに置くのは目撃記録・写真と同じ理由で、recomputeDrunkWineAggregates /
// buildSightingValues / buildTastingValues / cleanupPhotoObjects といった
// モジュール私有のヘルパと同じ batch に積む必要があるため。
//
// 写真の実体だけは2段階目(saveImportBatchPhotos)になる。R2キーが batchId 依存で、
// バッチ行が確定するまでキーを採番できないため(エントリ写真と同じ制約)。

export interface BulkRegisterFromScanResult {
	/** 作成した一括登録バッチのID。写真アップロード(2段階目)がこれを使う */
	batchId: string;
	/** 紐付けた場所のID。場所を指定しなかった場合は null */
	placeId: string | null;
	/** 新規作成した銘柄の件数 */
	createdCount: number;
	/** 既存エントリに目撃記録だけを足した件数 */
	matchedCount: number;
	/** 作成した目撃記録の件数(= items の件数) */
	sightingCount: number;
	/** 作成した飲用記録の件数 */
	tastingCount: number;
}

/**
 * db.batch に積める文の型。db.batch は「1件以上」をタプルで要求するので、
 * 件数が実行時に決まるこの経路では配列で組み立ててから最後にタプルへ寄せる。
 */
type BatchStatement = Parameters<typeof db.batch>[0][number];

/**
 * 集計キャッシュの一括再計算。**1文で全対象を更新する**が、id を ID_CHUNK_SIZE で
 * 分割して積むのは D1 のバインド変数上限に触れないため(1回の一括登録は最大
 * MAX_ITEMS_PER_IMPORT 件 = 80件になりうる)。式は単体経路と同じものを使う。
 */
function recomputeDrunkWineAggregatesBulk(
	userId: string,
	ids: string[],
): BatchStatement[] {
	const statements: BatchStatement[] = [];
	for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
		const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
		statements.push(
			db
				.update(drunkWine)
				.set({
					tastingCount: TASTING_COUNT_EXPR,
					lastDrankOn: MAX_DRANK_ON_EXPR,
					sightingCount: SIGHTING_COUNT_EXPR,
					lastSeenOn: MAX_SEEN_ON_EXPR,
				})
				.where(and(eq(drunkWine.userId, userId), inArray(drunkWine.id, chunk))),
		);
	}
	return statements;
}

/**
 * 写真から抽出した銘柄群をまとめて登録する。
 *
 * - `existingId` の項目は銘柄を作らず、その既存エントリに目撃記録だけを足す
 *   (同じワインを別の店でも見かけた、を1エントリ + 目撃N件で表す設計)
 * - 目撃記録の場所・見かけた日・バッチIDはバッチ共通の値をここで埋める
 * - `status` 未指定の新規銘柄は "spotted"(見かけた)。createDrunkWine の既定
 *   (finished)をそのまま使うと、見かけただけのワインが飲み終わり扱いになり、
 *   日付なしの飲用記録まで作られてしまう
 *
 * **全成功か全失敗**なので、ネットワーク都合で再送されても部分的な重複は残らない
 * (同じ入力をユーザが2回確定すれば2バッチできるが、それは意図した操作)。
 */
export async function bulkRegisterFromScan(
	userId: string,
	input: BulkRegisterFromScanInput,
): Promise<BulkRegisterFromScanResult> {
	// 静的マスタ(AOP・品種)の検証は新規銘柄ぶんだけ。1件でも不正なら登録全体を
	// 断る(部分適用にすると、どれが入ってどれが入らなかったかを画面が説明できない)
	for (const item of input.items) {
		if (item.wine) assertValidRefs(item.wine);
	}

	// 既存エントリの所有権をまとめて確認する。1件ずつ SELECT すると件数ぶん
	// ラウンドトリップが増えるので、id の集合で1回引いて差分を見る。
	const existingIds = [
		...new Set(
			input.items
				.map((i) => i.existingId)
				.filter((id): id is string => id != null),
		),
	];
	if (existingIds.length > 0) {
		const rows = await db
			.select({ id: drunkWine.id })
			.from(drunkWine)
			.where(
				and(eq(drunkWine.userId, userId), inArray(drunkWine.id, existingIds)),
			);
		if (rows.length !== existingIds.length) {
			// 存在しない/他ユーザ所有は区別しない(存在の探索を防ぐ規約)
			throw new NotFoundError("Entry not found");
		}
	}

	// 場所: 既存の指定は所有権を確認し、新規は同じ batch で作る
	if (input.placeId) {
		await assertOwnsSightingRefs(userId, { placeId: input.placeId });
	}
	const newPlaceId = input.newPlace ? crypto.randomUUID() : null;
	const placeId = input.placeId ?? newPlaceId;

	const batchId = crypto.randomUUID();
	const statements: BatchStatement[] = [];

	if (input.newPlace) {
		statements.push(
			db.insert(place).values({
				id: newPlaceId as string,
				userId,
				name: input.newPlace.name,
				kind: input.newPlace.kind ?? DEFAULT_PLACE_KIND,
				memo: input.newPlace.memo ?? null,
			}),
		);
	}

	statements.push(
		db.insert(importBatch).values({
			id: batchId,
			userId,
			placeId,
			seenOn: input.seenOn ?? null,
			// 写真の実体は2段階目(saveImportBatchPhotos)で入る
			photoKeys: [],
		}),
	);

	const affectedIds: string[] = [];
	let createdCount = 0;
	let tastingCount = 0;
	for (const item of input.items) {
		let drunkWineId: string;
		if (item.wine) {
			drunkWineId = crypto.randomUUID();
			createdCount += 1;
			statements.push(
				db.insert(drunkWine).values({
					id: drunkWineId,
					userId,
					name: item.wine.name,
					// 見かけただけ、が既定。飲んだかどうかは tasting の有無で表す
					status: item.wine.status ?? "spotted",
					...provenanceInsertValues(item.wine),
					vintage: item.wine.vintage ?? null,
					grapeVarietyIds: item.wine.grapeVarietyIds ?? [],
					producer: item.wine.producer ?? null,
					price: item.wine.price ?? null,
					// このバッチで新規作成したエントリだけに付ける(Issue #363 案A)。
					// 既存一致(item.existingId)はエントリを作らないので付けない
					// (足されるのは目撃記録と、指定があれば試飲記録。どちらも
					//  それぞれの batch_id で辿れる)。
					batchId,
				}),
			);
		} else {
			// refine 済みなので existingId は必ずある
			drunkWineId = item.existingId as string;
		}
		affectedIds.push(drunkWineId);

		statements.push(
			db.insert(wineSighting).values(
				buildSightingValues(userId, drunkWineId, {
					...item.sighting,
					placeId: placeId ?? undefined,
					batchId,
					seenOn: input.seenOn,
				}),
			),
		);

		if (item.tasting) {
			tastingCount += 1;
			statements.push(
				db.insert(wineTasting).values(
					// **batchId を必ず付ける**(#393)。既存エントリに足した試飲記録も
					// 取り消しの対象にするための唯一の手掛かり。
					buildTastingValues(userId, drunkWineId, item.tasting, batchId),
				),
			);
		}
	}

	// 集計キャッシュは INSERT 群の後に積む(D1 の batch は順次実行なので、この
	// UPDATE は同じ batch の INSERT の結果を見る)。新規銘柄も既存銘柄も対象。
	statements.push(...recomputeDrunkWineAggregatesBulk(userId, affectedIds));

	// items は1件以上(zod)なので statements も必ず1件以上になる
	await db.batch(statements as [BatchStatement, ...BatchStatement[]]);

	return {
		batchId,
		placeId,
		createdCount,
		matchedCount: input.items.length - createdCount,
		sightingCount: input.items.length,
		tastingCount,
	};
}

/**
 * 一括登録バッチの取り消し(Issue #363 案A)。
 *
 * **登録直後の完了導線からのみ呼ばれる、という前提はもう成立しない**。#385 が
 * 一括登録の履歴画面(`/cellar/import/history`)から**恒常的に**取り消せるようにした
 * ため、「取り消しが呼ばれる時点で他の操作が挟まっていない」とは限らない
 * (この JSDoc は以前その前提で「登録後にユーザが編集した銘柄をどう扱うか」の論点を
 * 回避していると書いていたが、実態と乖離していた。#393)。編集済みエントリの扱いは
 * 未決の論点のままで、現状の防波堤はクライアント側の確認ダイアログの警告だけ
 * (`ImportBatchSummary.hasEditedEntries` が材料)。サーバ側は無条件に削除する。
 *
 * 削除対象は **このバッチで新規作成されたエントリ**(drunk_wine.batch_id が
 * このバッチのもの)のみ。「既存エントリに目撃記録が増えただけ」のものは
 * エントリを消さず、目撃記録だけを取り消して集計を再計算する(バッチと
 * 無関係な過去のデータを失わないため、issue本文の案Aの要点)。
 *
 * **試飲記録もバッチ由来のものだけ消す**(#393)。一括登録は既存エントリにも
 * 試飲記録を足せる(「このワインを飲んだ」)ため、これを消さないと取り消しても
 * tasting_count / last_drank_on / last_rating が戻らない。新規作成エントリぶんは
 * エントリ削除の FK cascade でも消えるが、**既存エントリに足したぶんは
 * wine_tasting.batch_id を辿らないと特定できない**。ユーザが手動で足した
 * 試飲記録は batch_id が null なので巻き込まない。
 *
 * バッチが作った place は消さない(参照が無くなっても場所マスタとして残す。
 * 不要ならユーザが deletePlace で個別に消せる)。バッチ写真
 * (import_batch.photo_keys)はエントリ写真とは別物でどの削除経路も掃除しない
 * ため、ここで明示的に消す(サムネイルは保存していないので thumb 分は不要)。
 */
export async function undoImportBatch(
	userId: string,
	batchId: string,
): Promise<{ deletedCount: number }> {
	const [batch] = await db
		.select({ photoKeys: importBatch.photoKeys })
		.from(importBatch)
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)));
	if (!batch) throw new NotFoundError("Batch not found");

	const createdRows = await db
		.select({ id: drunkWine.id, photoKeys: drunkWine.photoKeys })
		.from(drunkWine)
		.where(and(eq(drunkWine.batchId, batchId), eq(drunkWine.userId, userId)));
	const createdIds = new Set(createdRows.map((row) => row.id));

	const sightingRows = await db
		.select({ drunkWineId: wineSighting.drunkWineId })
		.from(wineSighting)
		.where(
			and(eq(wineSighting.batchId, batchId), eq(wineSighting.userId, userId)),
		);
	// バッチが足した試飲記録の付き先も拾う(#393)。実際には試飲記録が付く項目には
	// 必ず目撃記録も付く(1項目=1目撃記録)ので集合は sighting 側に含まれるはずだが、
	// **集計の再計算漏れは「取り消したのに数値が戻らない」という形で表に出る**ので、
	// 取り消す行の付き先を両方から集める形にして依存を断つ。
	const tastingRows = await db
		.select({ drunkWineId: wineTasting.drunkWineId })
		.from(wineTasting)
		.where(
			and(eq(wineTasting.batchId, batchId), eq(wineTasting.userId, userId)),
		);
	// 新規作成エントリ以外(=既存エントリに記録が増えただけ)は、削除後に集計
	// (sightingCount/lastSeenOn/tastingCount/lastDrankOn/lastRating)を再計算する。
	// 新規作成エントリはエントリごと消えるので再計算は要らない。
	const touchedExistingIds = [
		...new Set(
			[...sightingRows, ...tastingRows]
				.map((row) => row.drunkWineId)
				.filter((id) => !createdIds.has(id)),
		),
	];

	const statements: BatchStatement[] = [
		db
			.delete(wineSighting)
			.where(
				and(eq(wineSighting.batchId, batchId), eq(wineSighting.userId, userId)),
			),
		// バッチ由来の試飲記録(batch_id 一致)だけを消す。手動で足したものは
		// batch_id が null なので残る。**エントリ削除より前に置く**必要は無いが、
		// 削除対象の集合は batch_id で決まるので順序に依存しない。
		db
			.delete(wineTasting)
			.where(
				and(eq(wineTasting.batchId, batchId), eq(wineTasting.userId, userId)),
			),
		db
			.delete(drunkWine)
			.where(and(eq(drunkWine.batchId, batchId), eq(drunkWine.userId, userId))),
	];
	if (touchedExistingIds.length > 0) {
		statements.push(
			...recomputeDrunkWineAggregatesBulk(userId, touchedExistingIds),
		);
	}
	statements.push(
		db
			.delete(importBatch)
			.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId))),
	);
	await db.batch(statements as [BatchStatement, ...BatchStatement[]]);

	// D1の書き込みは既に確定しているので、R2掃除の失敗で「取り消せなかった」とは返さない(#249と同じ扱い)。
	const entryPhotoKeys = createdRows.flatMap((row) =>
		row.photoKeys.length > 0
			? [...row.photoKeys, ...row.photoKeys.map(thumbKeyForPhotoKey)]
			: [],
	);
	const photoKeys = [...batch.photoKeys, ...entryPhotoKeys];
	await cleanupPhotoObjects(photoKeys, {
		userId,
		entryId: batchId,
		phase: "import-batch-undone",
	});

	// 取り消しの監査ライン(#394)。3テーブル(cascade 込み)とR2写真に及ぶ不可逆の操作
	// なので、成功も1行残す。**再構成の手段が無い**ため、後から「何がどれだけ消えたか」を
	// 知る唯一の手掛かりになる。recomputedCount は「既存エントリから記録だけを取り消した」
	// 件数で、deletedCount(このバッチで作られて消えたエントリ)とは別物。
	logInfo("import batch undone", {
		userId,
		batchId,
		deletedCount: createdRows.length,
		sightingCount: sightingRows.length,
		tastingCount: tastingRows.length,
		recomputedCount: touchedExistingIds.length,
		photoKeyCount: photoKeys.length,
	});

	return { deletedCount: createdRows.length };
}

/** 一括登録バッチ履歴の一覧に返す1件。 */
export interface ImportBatchSummary {
	id: string;
	placeId: string | null;
	placeName: string | null;
	/** 見かけた日 "YYYY-MM-DD" */
	seenOn: string | null;
	photoCount: number;
	createdAt: number;
	/** このバッチで新規作成されたエントリの件数 */
	createdCount: number;
	/** 既存エントリに目撃記録を追加しただけの件数(sightingCount - createdCount) */
	matchedCount: number;
	/** 目撃記録の総数(createdCount + matchedCount) */
	sightingCount: number;
	/**
	 * 新規作成エントリのいずれかが登録後に編集されている(updatedAt が createdAt より
	 * 1秒以上後。同一INSERT文内の誤差を編集扱いしないための閾値)。取り消すと編集内容も
	 * 失われるため、一覧・確認ダイアログで警告する材料に使う(Issue #380 の未確定の論点)。
	 */
	hasEditedEntries: boolean;
}

const IMPORT_BATCH_HISTORY_LIMIT = 50;

/**
 * 過去の一括登録バッチを新しい順に一覧する(Issue #380)。#378 は取り消し導線を
 * 登録直後の完了画面だけに限定したため件数の集計を持たなかったが、ここでは
 * バッチ一覧画面から後からでも取り消せるようにするため、drunk_wine /
 * wine_sighting を都度集計する(import_batch 自体には件数列を持たせない)。
 *
 * 全エントリが個別削除済みのバッチ(#380 未確定論点の1つ)は特別扱いしない。
 * createdCount/sightingCount が0のまま一覧に出て、取り消しは
 * undoImportBatch が対象0件のまま成功しバッチ行だけを消す(害が無い)。
 */
export async function listImportBatches(
	userId: string,
): Promise<ImportBatchSummary[]> {
	const batches = await db
		.select({
			id: importBatch.id,
			placeId: importBatch.placeId,
			placeName: place.name,
			seenOn: importBatch.seenOn,
			photoKeys: importBatch.photoKeys,
			createdAt: importBatch.createdAt,
		})
		.from(importBatch)
		.leftJoin(place, eq(place.id, importBatch.placeId))
		.where(eq(importBatch.userId, userId))
		.orderBy(desc(importBatch.createdAt))
		.limit(IMPORT_BATCH_HISTORY_LIMIT);
	if (batches.length === 0) return [];

	const ids = batches.map((b) => b.id);
	const [createdStats, sightingStats] = await Promise.all([
		db
			.select({
				batchId: drunkWine.batchId,
				createdCount: sql<number>`count(*)`,
				editedCount: sql<number>`sum(case when ${drunkWine.updatedAt} > ${drunkWine.createdAt} + 1000 then 1 else 0 end)`,
			})
			.from(drunkWine)
			.where(and(eq(drunkWine.userId, userId), inArray(drunkWine.batchId, ids)))
			.groupBy(drunkWine.batchId),
		db
			.select({
				batchId: wineSighting.batchId,
				sightingCount: sql<number>`count(*)`,
			})
			.from(wineSighting)
			.where(
				and(
					eq(wineSighting.userId, userId),
					inArray(wineSighting.batchId, ids),
				),
			)
			.groupBy(wineSighting.batchId),
	]);

	const createdByBatch = new Map(
		createdStats
			.filter((r): r is typeof r & { batchId: string } => r.batchId != null)
			.map((r) => [r.batchId, r]),
	);
	const sightingByBatch = new Map(
		sightingStats
			.filter((r): r is typeof r & { batchId: string } => r.batchId != null)
			.map((r) => [r.batchId, Number(r.sightingCount)]),
	);

	return batches.map((b) => {
		const created = createdByBatch.get(b.id);
		const createdCount = Number(created?.createdCount ?? 0);
		const sightingCount = sightingByBatch.get(b.id) ?? 0;
		return {
			id: b.id,
			placeId: b.placeId,
			placeName: b.placeName,
			seenOn: b.seenOn,
			photoCount: b.photoKeys.length,
			createdAt: b.createdAt.getTime(),
			createdCount,
			matchedCount: Math.max(0, sightingCount - createdCount),
			sightingCount,
			hasEditedEntries: Number(created?.editedCount ?? 0) > 0,
		};
	});
}

/** 一括登録バッチ1件(写真アップロードの応答)。 */
export interface ImportBatchEntry {
	id: string;
	placeId: string | null;
	seenOn: string | null;
	/** 写真の相対URL(/api/images/...)。撮影順 = 目撃記録の photoIndex が指す順 */
	photoUrls: string[];
	createdAt: number;
}

function toImportBatchEntry(
	row: typeof importBatch.$inferSelect,
): ImportBatchEntry {
	return {
		id: row.id,
		placeId: row.placeId,
		seenOn: row.seenOn,
		photoUrls: row.photoKeys.map(imagePathForKey),
		createdAt: row.createdAt.getTime(),
	};
}

/**
 * 一括登録バッチ1件を取り出す(本人所有のみ)。履歴からの再解析(#427)が、
 * 保存済みの写真URLと当時の場所・見かけた日を読み直すために使う。
 *
 * 写真URLは `/api/images/wines/...` の相対URLで、**本人セッションの same-origin
 * 取得で読める**(署名URLは要らない。images/signed-url.ts の認可経路1)。
 * 再解析はアプリ内のログイン済み画面から走るので、クライアントがこのURLを
 * fetch して解析用に縮小できる。
 */
export async function getImportBatch(
	userId: string,
	batchId: string,
): Promise<ImportBatchEntry> {
	const [row] = await db
		.select()
		.from(importBatch)
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)));
	if (!row) throw new NotFoundError("Import batch not found");
	return toImportBatchEntry(row);
}

/**
 * 一括登録バッチの写真をR2へ保存し、キー配列を確定する(2段階目)。
 *
 * リスト/棚の写真は**バッチに1回だけ置き、銘柄ごとに複製しない**。目撃記録は
 * photoIndex でこの配列を指す。したがって**順番と枚数が登録時の申告
 * (photoCount)と一致していること**が意味の前提になり、ここでずれると
 * 「別の写真で見かけたことになる」ため、枚数が合わなければ拒否する。
 *
 * R2キーは `wines/{userId}/{batchId}/{photoId}.{ext}`。エントリ写真と同じ
 * `wines/` 接頭辞に載せる理由は db/schema.ts の importBatch の JSDoc を参照
 * (認可・署名URL・退会時削除がこのレイアウトと一対の契約になっている)。
 *
 * 既に写真が入っているバッチへの再アップロードは受け付けない(冪等性のためでは
 * なく、目撃記録の photoIndex が既に確定した配列を指しているため。差し替えたい
 * ケースは現状の導線に無い)。
 */
export async function saveImportBatchPhotos(
	userId: string,
	batchId: string,
	photos: Array<{ bytes: ArrayBuffer | Uint8Array; mimeType: string }>,
): Promise<ImportBatchEntry> {
	if (photos.length > MAX_PHOTOS_PER_IMPORT_BATCH) {
		throw new BadRequestError(
			`写真は最大${MAX_PHOTOS_PER_IMPORT_BATCH}枚までです`,
		);
	}
	const [existing] = await db
		.select()
		.from(importBatch)
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)));
	if (!existing) throw new NotFoundError("Import batch not found");
	if (existing.photoKeys.length > 0) {
		throw new ConflictError("このバッチの写真は保存済みです");
	}

	const putKeys: string[] = [];
	try {
		for (const photo of photos) {
			// 保存する Content-Type は申告値ではなく実バイトから確定する(#150)。
			// 新しい入力経路を足すときに必ずこの関門を通す(#174)。
			const bytes =
				photo.bytes instanceof Uint8Array
					? photo.bytes
					: new Uint8Array(photo.bytes);
			const mime = resolveStoredPhotoMime(bytes, photo.mimeType);
			if (!mime) {
				throw new BadRequestError(
					"画像として認識できないか、形式が申告値と一致しないファイルが含まれています",
				);
			}
			const key = buildWinePhotoKey(userId, batchId, crypto.randomUUID(), mime);
			await env.AVATARS.put(key, bytes, {
				httpMetadata: { contentType: mime },
			});
			putKeys.push(key);
		}
	} catch (e) {
		// 巻き戻しの成否に関わらず元例外を投げる(掃除の失敗で真因を隠さない)
		await cleanupPhotoObjects(putKeys, {
			userId,
			entryId: batchId,
			phase: "import-batch-rollback",
			originalErr: e,
		});
		throw e;
	}

	const [row] = await db
		.update(importBatch)
		.set({ photoKeys: putKeys })
		.where(and(eq(importBatch.id, batchId), eq(importBatch.userId, userId)))
		.returning();
	if (!row) {
		await cleanupPhotoObjects(putKeys, {
			userId,
			entryId: batchId,
			phase: "import-batch-deleted",
		});
		throw new NotFoundError("Import batch not found");
	}
	return toImportBatchEntry(row);
}
