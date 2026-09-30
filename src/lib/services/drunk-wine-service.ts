import { env } from "cloudflare:workers";
import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	drunkWine,
	importBatch,
	place,
	wineEncounter,
	winePhoto,
} from "#/db/schema";
import type { LabelPrice, LabelReferenceLink } from "#/lib/ai/label-extraction";
import {
	type PhotoKind,
	resolveStoredPhotoKinds,
} from "#/lib/ai/wine-list-extraction";
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
import {
	normalizeStoredMarketPrices,
	normalizeStoredReferenceLinks,
} from "#/lib/drunk-wine/references";
import type {
	CreateWineTastingInput,
	UpdateDrunkWineInput,
	UpdateWineTastingInput,
} from "#/lib/drunk-wine/schema";
import { DEFAULT_WINE_STATUS, type WineStatus } from "#/lib/drunk-wine/status";
import { BadRequestError, NotFoundError } from "#/lib/errors";
import { imagePathForKey } from "#/lib/images/signed-url";
import { type LogFields, logError, logInfo, logWarn } from "#/lib/logger";
import {
	type CreateDrunkWineWithSightingInput,
	type CreateEntrySightingInput,
	type CreateWineEncounterInput,
	type CreateWineSightingInput,
	createWineEncounterInput,
	type UpdateWineEncounterInput,
	type UpdateWineSightingInput,
	updateWineEncounterInput,
} from "#/lib/place/schema";
import { prepareNewPlace } from "#/lib/services/place-service";
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
// D1(drunk_wine / wine_encounter)とR2(写真)への薄い橋渡しに徹する。
// AOP・品種は静的マスタ参照(FKなし)のため、ここで存在検証する。
//
// 所有状態(status)と体験履歴(wine_encounter)は直交する2軸で、互いに自動連動しない
// (Issue #195 / #606)。唯一の例外は「飲んだ」操作(markWineDrunk)で、drank=1 の
// 体験記録の追加と status='finished' を1操作としてここに閉じている。
//
// 旧 wine_tasting / wine_sighting への読み書きは全廃した(0040 で wine_encounter へ
// 移送済み)。既存の server fn・MCP が使う旧関数名(listWineTastings 等)は互換
// アダプタとして残し、内部では drank 条件付きで wine_encounter を読む
// (listWineTastings は drank=1、listWineSightings は drank=0 を返す)。

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
	/** 最新の飲用回の日。飲用記録が無い/全件日付未入力なら null */
	lastDrankOn: string | null;
	/** 飲用記録の件数。0 なら「まだ飲んだことがない」 */
	tastingCount: number;
	/** 最新の体験記録の日。体験記録が無い/全件日付未入力なら null */
	lastEncounteredOn: string | null;
	/** 体験記録の件数。0 なら「どこでも出会っていない」 */
	encounterCount: number;
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
	/**
	 * 銘柄についてのコメント(香り・味わい・生産者)。解析が付与し、利用者が編集できる
	 * (#471)。飲用記録の memo(lastMemo)とは別物。
	 */
	note: string | null;
	price: number | null;
	/**
	 * 解析の参考サイトの一覧。空配列=未取得。解析の表示専用だったものを
	 * 登録後も残すために銘柄に保存する。
	 */
	referenceLinks: LabelReferenceLink[];
	/**
	 * 解析の市場価格の一覧。空配列=未取得。同上(「その店での売値」の
	 * 目撃記録とは別物)。
	 */
	prices: LabelPrice[];
	/** 写真の相対URL(/api/images/...)の配列。表示順で先頭=代表。呼び出し側で必要なら絶対化する */
	photoUrls: string[];
	/**
	 * 一覧表示用サムネイルの相対URL(photoUrls と同じ順・同じ長さ)。キーは原寸から
	 * 導出する(#237)。サムネイルが未保存の写真(MCP経由・本機能より前の写真)でも、
	 * 配信ルートが原寸へフォールバックするのでそのまま使える。
	 */
	thumbUrls: string[];
	/**
	 * 写真ごとの由来(photoUrls と同じ順・同じ長さ。drizzle/0035)。
	 * `"web"` の写真にだけギャラリーが WEB overlay を出す。保存値のパース失敗・
	 * 長さ不一致・未知値は `resolveStoredPhotoKinds` が `"bottle"` に倒す。
	 */
	photoKinds: PhotoKind[];
	createdAt: number;
	updatedAt: number;
}

/**
 * 旧飲用記録の表示形。互換アダプタ(listWineTastings 等)が wine_encounter の
 * drank=1 の行から組み立てる。UI は無変更(PR2 で Encounter 側へ統合する)。
 */
export interface WineTastingEntry {
	id: string;
	drankOn: string | null;
	rating: number | null;
	memo: string | null;
	createdAt: number;
	updatedAt: number;
}

/**
 * 体験記録1件の表示形。「そのワインに出会った1回」で、飲んだかどうかは drank。
 * 旧 WineTastingEntry(drank=1 の射影)と旧 WineSightingEntry(drank=0 の射影)を
 * 1つに統合したもの。PR2 の EncounterList / 詳細の時系列がこの形で読む。
 */
export interface WineEncounterEntry {
	id: string;
	/** この回に飲んだか */
	drank: boolean;
	occurredOn: string | null;
	rating: number | null;
	price: number | null;
	memo: string | null;
	placeId: string | null;
	/** 場所の表示名。placeId が無い/場所が消された場合は null */
	placeName: string | null;
	batchId: string | null;
	photoIndex: number | null;
	/**
	 * 出会ったときの写真(一括登録のバッチ写真)の相対URL。手で足した体験記録や、
	 * 写真の保存に失敗したバッチでは null。**後方互換の先頭1枚**で、新規の表示は
	 * `photoUrls`(対応写真のすべて)を見る。
	 */
	photoUrl: string | null;
	/**
	 * そのワインが写っていた写真の相対URLの一覧(#574)。AIの画像-ワイン対応の
	 * すべてで、順序は登録時の番号順。範囲外の番号は落とすので空にもなる。
	 */
	photoUrls: string[];
	createdAt: number;
	updatedAt: number;
}

/**
 * 旧目撃記録の表示形。互換アダプタ(listWineSightings 等)が wine_encounter の
 * drank=0 の行から組み立てる。UI は無変更(PR2 で Encounter 側へ統合する)。
 */
export interface WineSightingEntry {
	id: string;
	placeId: string | null;
	/** 場所の表示名。placeId が無い/場所が消された場合は null */
	placeName: string | null;
	batchId: string | null;
	photoIndex: number | null;
	/**
	 * 見かけたときの写真(一括登録のバッチ写真)の相対URL。手で足した目撃記録や、
	 * 写真の保存に失敗したバッチでは null。**後方互換の先頭1枚**で、新規の表示は
	 * `photoUrls`(対応写真のすべて)を見る。
	 */
	photoUrl: string | null;
	/**
	 * そのワインが写っていた写真の相対URLの一覧(#574)。AIの画像-ワイン対応の
	 * すべてで、順序は登録時の番号順。範囲外の番号は落とすので空にもなる。
	 */
	photoUrls: string[];
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
/**
 * 体験記録の行に、表示用の場所名と由来バッチの写真キー配列(いずれも LEFT JOIN で
 * 引く)を足したもの。写真は「バッチの photoKeys の photoIndex 番目」なので、
 * 行だけでは URL を組み立てられない。
 */
export type WineEncounterRow = typeof wineEncounter.$inferSelect & {
	placeName: string | null;
	batchPhotoKeys: string[] | null;
};

function toEntry(row: DrunkWineRow, photos: EntryPhoto[]): DrunkWineEntry {
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
	const entryPhotos = resolveEntryPhotos(row, photos);
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		lastDrankOn: row.lastDrankOn,
		tastingCount: row.tastingCount,
		lastEncounteredOn: row.lastEncounteredOn,
		encounterCount: row.encounterCount,
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
		note: row.note,
		price: row.price,
		// 旧行・壊れた値は空配列へ退避する(保存時に正規化済みなので通常は素通し)。
		referenceLinks: normalizeStoredReferenceLinks(row.referenceLinks),
		prices: normalizeStoredMarketPrices(row.marketPrices),
		photoUrls: entryPhotos.keys.map(imagePathForKey),
		thumbUrls: entryPhotos.keys.map((key) =>
			imagePathForKey(thumbKeyForPhotoKey(key)),
		),
		photoKinds: entryPhotos.kinds,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * 銘柄の写真1枚の読み取り形。`winePhoto` 子テーブルの行に対応し、表示順
 * (position 昇順)に並べたもの。R2キーと由来だけを持ち、URL組み立て・
 * サムネイル導出は呼び出し側(toEntry・削除経路の掃除)が担う。
 */
export interface EntryPhoto {
	key: string;
	kind: PhotoKind;
}

/**
 * 子テーブル行の由来を正規化する。kind 列は新コードだけが書くが D1 に CHECK が
 * 無いため、未知値は bottle(overlay なし)に倒す(resolveStoredPhotoKinds と同じ方向)。
 */
function normalizeWinePhotoKind(value: unknown): PhotoKind {
	return value === "web" ? "web" : "bottle";
}

/**
 * 表示用の写真集合を決める(Issue #645 の読み取りの SSOT。写真を読む全経路が
 * `listEntryPhotosBulk` で引いた行をここに通す)。
 *
 * 正本は子テーブル。子テーブルが空の行に限り旧列(`photo_keys` / `photo_kinds`)へ
 * フォールバックする——デプロイ時の「新スキーマ×旧コード」の window で旧コードが
 * 書いた写真は旧列にだけ載るため、そのまま子テーブルだけを読むと写真が消えたように
 * 見える。フォールバックは warn を残すので、`bun run logs --grep` で取りこぼしを
 * 棚卸しできる。子テーブルへは次の書き込み(sync / append)で寄る。
 */
export function resolveEntryPhotos(
	row: Pick<DrunkWineRow, "id" | "photoKeys" | "photoKinds">,
	child: EntryPhoto[],
): { keys: string[]; kinds: PhotoKind[] } {
	if (child.length > 0) {
		return {
			keys: child.map((photo) => photo.key),
			kinds: child.map((photo) => photo.kind),
		};
	}
	if (row.photoKeys.length > 0) {
		logWarn("wine photo legacy fallback", {
			drunkWineId: row.id,
			legacyCount: row.photoKeys.length,
		});
		return {
			keys: row.photoKeys,
			kinds: resolveStoredPhotoKinds(row.photoKeys, row.photoKinds),
		};
	}
	return { keys: [], kinds: [] };
}

/**
 * 旧列だけに載っている写真キーを子テーブルへ寄せる(#645 の遅延バックフィル)。
 *
 * マイグレーション時のバックフィル以降に旧列だけが書かれた行(デプロイの
 * 「新スキーマ×旧コード」の window で旧コードが書いた分)が対象で、通常の
 * 二重化が保たれている行では読み直すだけで何も書かない。sync / append の先頭で
 * 呼び、以降は子テーブルだけを見ればよい——repair 後の layout 検証は旧列だけの
 * キーも通る(再アップロードを強いない)。
 *
 * INSERT OR IGNORE + unique 制約(`wine_photo_entry_r2_key_uq`)なので、
 * 多重実行・並行実行でも行は増えない。
 */
async function repairLegacyPhotos(
	userId: string,
	id: string,
	legacyKeys: string[],
	legacyKinds: PhotoKind[],
): Promise<{ id: string; r2Key: string; kind: PhotoKind; position: number }[]> {
	const readChild = () =>
		db
			.select({
				id: winePhoto.id,
				r2Key: winePhoto.r2Key,
				kind: winePhoto.kind,
				position: winePhoto.position,
			})
			.from(winePhoto)
			.where(and(eq(winePhoto.drunkWineId, id), eq(winePhoto.userId, userId)))
			.orderBy(asc(winePhoto.position));
	const base = await readChild();
	const baseSet = new Set(base.map((row) => row.r2Key));
	const missing = legacyKeys.filter((key) => !baseSet.has(key));
	if (missing.length === 0) return base;
	const kindByKey = new Map(
		legacyKeys.map((key, index) => [
			key,
			legacyKinds[index] ?? ("bottle" as PhotoKind),
		]),
	);
	const inserts = missing.map((key, index) => ({
		id: crypto.randomUUID(),
		drunkWineId: id,
		userId,
		r2Key: key,
		kind: kindByKey.get(key) ?? "bottle",
		position: base.length + index,
	}));
	// 1件ずつ INSERT OR IGNORE で書く(db.batch に載せるほどではなく、OR IGNORE が
	// あるので途中まで書けても後の repair が残りを足す)。
	for (const values of inserts) {
		await db
			.insert(winePhoto)
			.values(values)
			.onConflictDoNothing({
				target: [winePhoto.drunkWineId, winePhoto.r2Key],
			});
	}
	return readChild();
}

/**
 * 複数エントリの写真を行単位で一括取得する(position 順)。
 *
 * 一覧・詳細のように N 件のエントリを組み立てる経路が、エントリごとに SELECT すると
 * 件数ぶんラウンドトリップが増えるため、id の集合で1回(上限超過時は ID_CHUNK_SIZE
 * で分割)引いて Map に畳む。D1 のバインド変数上限(1クエリ100個)に触れないよう
 * `recomputeDrunkWineAggregatesBulk` と同じ単位で割る。
 */
export async function listEntryPhotosBulk(
	userId: string,
	ids: string[],
): Promise<Map<string, EntryPhoto[]>> {
	const out = new Map<string, EntryPhoto[]>();
	const uniqueIds = [...new Set(ids)];
	if (uniqueIds.length === 0) return out;
	for (let i = 0; i < uniqueIds.length; i += ID_CHUNK_SIZE) {
		const chunk = uniqueIds.slice(i, i + ID_CHUNK_SIZE);
		const rows = await db
			.select({
				drunkWineId: winePhoto.drunkWineId,
				r2Key: winePhoto.r2Key,
				kind: winePhoto.kind,
			})
			.from(winePhoto)
			.where(
				and(
					eq(winePhoto.userId, userId),
					inArray(winePhoto.drunkWineId, chunk),
				),
			)
			.orderBy(
				asc(winePhoto.drunkWineId),
				asc(winePhoto.position),
				sql`${winePhoto}."rowid" asc`,
			);
		for (const row of rows) {
			const list = out.get(row.drunkWineId) ?? [];
			list.push({ key: row.r2Key, kind: normalizeWinePhotoKind(row.kind) });
			out.set(row.drunkWineId, list);
		}
	}
	return out;
}

/** 1エントリぶんの写真。単件の読み直し(entryFromBatch・単件取得・削除前読み等)が使う内部版。 */
async function listEntryPhotos(
	userId: string,
	id: string,
): Promise<EntryPhoto[]> {
	return (await listEntryPhotosBulk(userId, [id])).get(id) ?? [];
}

/**
 * エントリ写真の INSERT 値を組み立てる(実行はしない。呼び出し側が db.batch に積む)。
 * bulkRegisterFromScan / adoptBatchPhotosForWines が、銘柄の INSERT と同じ batch で
 * 子テーブルへ書くために使う。position は startPosition からの連番(append が
 * 既存行の末尾に足すため、先頭以外から始める必要がある)。
 */
export function buildWinePhotoValues(
	userId: string,
	drunkWineId: string,
	photos: { key: string; kind: PhotoKind }[],
	startPosition = 0,
) {
	return photos.map((photo, index) => ({
		id: crypto.randomUUID(),
		drunkWineId,
		userId,
		r2Key: photo.key,
		kind: photo.kind,
		position: startPosition + index,
	}));
}

/**
 * 体験記録が参照するバッチ写真の番号の一覧(#574)。保存値の `photo_indexes` を
 * 優先し、NULL の従来行は `photo_index`(先頭1枚)へ退避する。整数以外・範囲外は
 * 落とす(存在しないキーの URL を作るとリンク切れの画像が並ぶ)。重複を潰して
 * 昇順に並べる(解析の `normalizePhotoIndexes` と同じ形)。
 */
export function encounterPhotoIndexes(row: {
	photoIndex: number | null;
	photoIndexes: number[] | null;
}): number[] {
	const stored = Array.isArray(row.photoIndexes)
		? row.photoIndexes
		: row.photoIndex != null
			? [row.photoIndex]
			: [];
	const out = new Set<number>();
	for (const raw of stored) {
		if (!Number.isInteger(raw) || (raw as number) < 0) continue;
		out.add(raw as number);
	}
	return [...out].sort((a, b) => a - b);
}

function toEncounterEntry(row: WineEncounterRow): WineEncounterEntry {
	// 由来写真は「バッチの photoKeys の photoIndexes 番目」。バッチが無い(手で足した
	// 体験記録)・写真をまだ保存していない・番号が範囲外のいずれでも、その写真は
	// 落とす。`photoUrl` は先頭1枚の後方互換。
	const photoUrls = encounterPhotoIndexes(row)
		.map((index) => row.batchPhotoKeys?.[index])
		.filter((key): key is string => !!key)
		.map(imagePathForKey);
	const photoUrl = photoUrls[0] ?? null;
	return {
		id: row.id,
		drank: row.drank,
		occurredOn: row.occurredOn,
		rating: row.rating,
		price: row.price,
		memo: row.memo,
		placeId: row.placeId,
		placeName: row.placeName,
		batchId: row.batchId,
		photoIndex: row.photoIndex,
		photoUrl,
		photoUrls,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

/**
 * 互換アダプタ・バッチ詳細表示用の射影。体験記録を旧目撃記録の形で返す。
 * drank の値は落とすので、呼び出し側が必要なら行から直接読む
 * (getImportBatchDetail が drank / rating を添える)。
 */
export function toSightingEntry(row: WineEncounterRow): WineSightingEntry {
	const encounter = toEncounterEntry(row);
	return {
		id: encounter.id,
		placeId: encounter.placeId,
		placeName: encounter.placeName,
		batchId: encounter.batchId,
		photoIndex: encounter.photoIndex,
		photoUrl: encounter.photoUrl,
		photoUrls: encounter.photoUrls,
		seenOn: encounter.occurredOn,
		price: encounter.price,
		memo: encounter.memo,
		createdAt: encounter.createdAt,
		updatedAt: encounter.updatedAt,
	};
}

// ---- 集計キャッシュの再計算 -----------------------------------------------
// 体験記録を書き換えるすべての経路が、変更文と同じ db.batch にこの UPDATE を積む。
// D1 の batch は暗黙トランザクションで文を順次実行するため、この UPDATE は先行の
// INSERT/DELETE の結果を見る。
//
// 加算・減算(quiz-service の `col + 1` / `max(0, col - 1)`)ではなく全再計算にする:
// last_drank_on / last_encountered_on は MAX なので、削除や日付変更で「次に大きい値」へ
// 戻す必要があり incremental 更新では原理的に表現できない。全再計算なら冪等で、
// マイグレーションのバックフィルと完全に同じ式を使え、整合が崩れても打ち直せば復旧する。

/** 「最新の飲用記録」の定義。SQLite は DESC で NULL を先頭に置くため、
 *  第1キーで日付未入力を末尾へ落とす。これで「最新行の occurred_on」と
 *  「max(occurred_on where drank=1)」が常に一致する。相関サブクエリ内では下記のエイリアスで修飾する。
 *
 * created_at は ms 精度のため同一msがありうる(連続タップ等)。最終キーの rowid desc で
 * 挿入順に倒し、同msでも後から入れた行を最新にする。無ければ同msの2件の順序が
 * 未定義になり、「同じ日の2件」のテストが運で落ちる。 */
const LATEST_DRANK_ENCOUNTER_ORDER = sql`order by e.occurred_on is null, e.occurred_on desc, e.created_at desc, e.rowid desc`;

/**
 * 最新の飲用記録(drank=1 の体験記録)の1列を引く相関サブクエリ。
 *
 * **テーブル修飾を自前で書く必要がある**。drizzle は SELECT の `sql` テンプレート内で
 * 列参照をテーブル名なし(`"rating"`, `"id"`)に描画するため、そのまま書くと内側の
 * wine_encounter と外側の drunk_wine で同名列(`id`)が衝突し、SQLite は内側スコープを
 * 優先して `wine_encounter.drunk_wine_id = wine_encounter.id` という常に偽の条件になる
 * (静かに null が返るだけでエラーにならない)。UPDATE の SET 内では逆に完全修飾で
 * 描画されるため、同じ式でも文脈によって意味が変わる。エイリアス `e` と
 * `"drunk_wine".id` で明示すれば、どちらの文脈でも正しく相関する。
 */
function latestDrankEncounterValue<T extends number | string>(
	column: typeof wineEncounter.rating | typeof wineEncounter.memo,
) {
	return sql<T | null>`(select e.${sql.raw(column.name)} from ${wineEncounter} e where e.drunk_wine_id = ${drunkWine}.id and e.drank = 1 ${LATEST_DRANK_ENCOUNTER_ORDER} limit 1)`;
}

const TASTING_COUNT_EXPR = sql`(select count(*) from ${wineEncounter} where ${wineEncounter.drunkWineId} = ${drunkWine.id} and ${wineEncounter.drank} = 1)`;
const MAX_DRANK_ON_EXPR = sql`(select max(${wineEncounter.occurredOn}) from ${wineEncounter} where ${wineEncounter.drunkWineId} = ${drunkWine.id} and ${wineEncounter.drank} = 1)`;
const ENCOUNTER_COUNT_EXPR = sql`(select count(*) from ${wineEncounter} where ${wineEncounter.drunkWineId} = ${drunkWine.id})`;
const MAX_ENCOUNTERED_ON_EXPR = sql`(select max(${wineEncounter.occurredOn}) from ${wineEncounter} where ${wineEncounter.drunkWineId} = ${drunkWine.id})`;

/**
 * 体験記録から集計キャッシュを再計算する UPDATE を組み立てる(実行はしない。
 * 呼び出し側が db.batch に積む)。
 *
 * 非正規化して持つのは MAX と COUNT だけ(last_drank_on / tasting_count と
 * last_encountered_on / encounter_count)。評価・メモは「最新1件の値」なので集計ではなく、
 * 読み取り時に selectEntry の相関サブクエリで導出する(#205)。
 *
 * **どの経路でも4列すべてを再計算する**。列ごとの変種を作ると「どの経路がどの列を
 * 保証するか」を呼び出し側が覚える必要が生まれ、経路が増えるたびに漏れる
 * (#177 / #185 と同じ類型)。全再計算は冪等なので、関係ない列は同じ値で
 * 書き戻されるだけで害がない。
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
			encounterCount: ENCOUNTER_COUNT_EXPR,
			lastEncounteredOn: MAX_ENCOUNTERED_ON_EXPR,
			...(extra?.status ? { status: extra.status } : {}),
		})
		.where(and(eq(drunkWine.id, drunkWineId), eq(drunkWine.userId, userId)));
}

/**
 * エントリを読み直す SELECT。最新の飲用記録(drank=1)の評価・メモを相関サブクエリで載せる。
 *
 * 列を増やして非正規化する案も採れるが、そうすると「最新1件の射影」を書き戻す
 * 経路がまた増え、#205 で消したはずの二重管理が名前を変えて戻ってくる。
 * (drunk_wine_id, drank, occurred_on) の複合インデックスが効くので、相関サブクエリでも
 * 1行あたりインデックス参照2回で済む。
 *
 * 変更系は db.batch の最後にこれを積んで最終状態を得る(UPDATE の RETURNING では
 * サブクエリを使えないため)。
 */
function selectEntry(userId: string, id: string) {
	return db
		.select({
			...getTableColumns(drunkWine),
			lastRating: latestDrankEncounterValue<number>(wineEncounter.rating),
			lastMemo: latestDrankEncounterValue<string>(wineEncounter.memo),
		})
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
}

/** db.batch の結果末尾(selectEntry)から1件取り出す。無ければ NotFound。 */
async function entryFromBatch(results: unknown[]): Promise<DrunkWineEntry> {
	const row = (results.at(-1) as DrunkWineRow[] | undefined)?.[0];
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row, await listEntryPhotos(row.userId, row.id));
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

export function assertValidRefs(input: {
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
export function provenanceInsertValues(input: {
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
	sighting?: CreateEntrySightingInput;
	/**
	 * 統合 UI が同時に作る体験記録(Issue #606 PR2)。`tasting` / `sighting` との
	 * 併用は受け付けない(同じ1回の出来事が2行になる旧体制へ戻るため)。
	 */
	encounter?: CreateWineEncounterInput;
	/** 解析の参考サイト・市場価格(未指定なら空)。形の検証は正規化が関門。 */
	referenceLinks?: unknown;
	prices?: unknown;
};

export async function createDrunkWine(
	userId: string,
	input: CreateDrunkWineWithSightingInput | CreateDrunkWineData,
): Promise<DrunkWineEntry> {
	assertValidRefs(input);
	const id = crypto.randomUUID();
	const status = input.status ?? DEFAULT_WINE_STATUS;
	// 統合 UI が送る体験記録1件。旧2セクションの同時指定とは排他で、
	// ある場合は status='finished' の自動飲用記録も付けない(呼び出し側が
	// 記録の内容を明示しているため)。
	const encounter = "encounter" in input ? input.encounter : undefined;
	// finished(手元にない)は「飲み終えた」の意なので、入力が無くても日付なしの
	// 飲用記録を1件作る。これにより「名前だけ入れて記録する」既存UX・旧データの
	// バックフィル規則・status を送らない旧MCPクライアントの挙動が同一になる。
	const tasting =
		input.tasting ??
		(!encounter && status === "finished"
			? ({} as CreateWineTastingInput)
			: undefined);
	// 写真から登録した回の「見かけた場所・見かけた日」。飲用記録と対称で、
	// 入力があったときだけ1件作る。
	const sighting = input.sighting;
	if (encounter && (tasting || sighting)) {
		throw new BadRequestError(
			"体験記録と飲用記録・見かけた記録は同時に指定できません",
		);
	}

	const values = {
		id,
		userId,
		name: input.name,
		status,
		...provenanceInsertValues(input),
		vintage: input.vintage ?? null,
		grapeVarietyIds: input.grapeVarietyIds ?? [],
		producer: input.producer ?? null,
		note: input.note ?? null,
		// 参考サイト・市場価格は銘柄に属するのでそのまま保存する(未指定なら空)。
		referenceLinks: normalizeStoredReferenceLinks(input.referenceLinks),
		marketPrices: normalizeStoredMarketPrices(input.prices),
	};

	if (!tasting && !sighting && !encounter) {
		const [row] = await db.insert(drunkWine).values(values).returning();
		if (!row) throw new Error("Failed to insert drunk wine");
		// 飲用記録が無いので最新1件も無い。読み直さずに null で組み立てる。
		// 作りたての行に写真は無いので子テーブルは空。
		return toEntry({ ...row, lastRating: null, lastMemo: null }, []);
	}

	// 場所: 既存の指定は所有権を確認し、新規は同じ batch で作る(一括登録と同じ形)。
	// 新規作成は prepareNewPlace(重複名の関門)を通す。
	const encounterPlaceId = encounter?.placeId;
	if (sighting?.placeId || encounterPlaceId) {
		await assertOwnsEncounterRefs(userId, {
			placeId: sighting?.placeId ?? encounterPlaceId ?? null,
		});
	}
	// 体験記録の入力は統合後の形で検証する(関門は place/schema.ts)。
	// 追加・更新の各経路と同じく、経路ごとに条件を書き散らさない。
	const parsedEncounter = encounter
		? createWineEncounterInput.parse(encounter)
		: null;
	// sighting と encounter の併用は上で弾いているので、両方に newPlace が
	// 入ることは無い。
	const newPlaceInput = sighting?.newPlace ?? parsedEncounter?.newPlace;
	const newPlace = newPlaceInput
		? await prepareNewPlace(userId, newPlaceInput)
		: null;

	// 銘柄・体験記録を1トランザクションで作る(写真と違いR2キーの物理制約が
	// 無い)。最後の SELECT から最終状態を得る。
	//
	// tasting + sighting の同時指定(#495)は体験記録2行になる。機械的に1行へ畳むと、
	// 利用者が別の出来事として記録したものを潰しうるため、移送と同じくマージしない。
	const statements: BatchStatement[] = [];
	if (newPlace) {
		statements.push(db.insert(place).values(newPlace));
	}
	statements.push(db.insert(drunkWine).values(values));
	if (tasting) {
		statements.push(
			db.insert(wineEncounter).values(
				buildEncounterValues(userId, id, {
					drank: true,
					occurredOn: tasting.drankOn,
					rating: tasting.rating,
					memo: tasting.memo,
				}),
			),
		);
	}
	if (sighting) {
		const placeId = sighting.placeId ?? newPlace?.id ?? null;
		statements.push(
			db.insert(wineEncounter).values(
				buildEncounterValues(userId, id, {
					drank: false,
					occurredOn: sighting.seenOn,
					price: sighting.price,
					memo: sighting.memo,
					...(placeId ? { placeId } : {}),
				}),
			),
		);
	}
	// 統合 UI からの体験記録は drank の値そのままの1行になる。レストランで飲んだ
	// 回も `drank=1` + `place_id` の1行で、「同じ1回の出来事を2回入力する」
	// 構造が DB にも現れない。
	if (parsedEncounter) {
		// placeId と newPlace は zod が排他にしているので、採番した場所が
		// あればそれを使い、無ければ入力の placeId のままにする。
		const placeId = newPlace?.id ?? parsedEncounter.placeId;
		statements.push(
			db.insert(wineEncounter).values(
				buildEncounterValues(userId, id, {
					...parsedEncounter,
					placeId: placeId ?? undefined,
				}),
			),
		);
	}
	statements.push(recomputeDrunkWineAggregates(userId, id));
	statements.push(selectEntry(userId, id));
	return entryFromBatch(
		await db.batch(statements as [BatchStatement, ...BatchStatement[]]),
	);
}

export async function updateDrunkWine(
	userId: string,
	input: UpdateDrunkWineInput & {
		/** 解析の参考サイト・市場価格。指定されたときだけ置き換える。 */
		referenceLinks?: unknown;
		prices?: unknown;
	},
): Promise<DrunkWineEntry> {
	assertValidRefs(input);
	const { id, referenceLinks, prices, ...patch } = input;
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
					note: patch.note,
					// 参考情報だけは差分ではなく置き換え。呼び出し側が現在の保存値と
					// 解析結果をマージ済みで送る(空配列で消せる)。
					...(referenceLinks !== undefined
						? {
								referenceLinks: normalizeStoredReferenceLinks(referenceLinks),
							}
						: {}),
					...(prices !== undefined
						? { marketPrices: normalizeStoredMarketPrices(prices) }
						: {}),
				})
				.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId))),
			selectEntry(userId, id),
		]),
	);
}

// ---- 体験記録 -------------------------------------------------------------
// 所有権確認 → 変更文 + 集計再計算 + 読み直しを1つの db.batch に積む。
// 別ファイルに切らずここに置くのは、recomputeDrunkWineAggregates / selectEntry /
// entryFromBatch といったモジュール私有のヘルパと同じ batch に積む必要があるため。

export function buildEncounterValues(
	userId: string,
	drunkWineId: string,
	input: CreateWineEncounterInput,
	/** 一括登録由来の場合のバッチID。手動追加は未指定(null)(#393)。 */
	batchId: string | null = null,
) {
	return {
		id: crypto.randomUUID(),
		drunkWineId,
		userId,
		placeId: input.placeId ?? null,
		batchId: input.batchId ?? batchId,
		photoIndex: input.photoIndex ?? null,
		// `photoIndex`(先頭1枚の後方互換)と併存する(#574)。空配列は送られて
		// こない(クライアントが省略する)が、来たらそのまま残す。
		photoIndexes: input.photoIndexes ?? null,
		occurredOn: input.occurredOn ?? null,
		drank: input.drank,
		// 評価は drank=1 のときだけ意味を持つ属性。OFF の行に残っていても
		// UI は出さないので、書き込みの関門で落とす(不可視のまま残さない)。
		rating: input.drank ? (input.rating ?? null) : null,
		price: input.price ?? null,
		memo: input.memo ?? null,
	};
}

/**
 * placeId / batchId は FK があるだけでは他ユーザの行も指せてしまう(FK は所有者を
 * 見ない)。他人の place を指した体験記録を作れると、一覧の placeName に他人の
 * 店名が出て情報が漏れる。参照する前に必ず所有権を確認する。
 *
 * 存在しない/他ユーザは区別せず同一エラー(存在の探索を防ぐ規約)。
 */
export async function assertOwnsEncounterRefs(
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

/**
 * 体験記録の一覧。出会った日の新しい順で、日付未入力は末尾。
 * 場所名は LEFT JOIN で引く — place が消えていても出会った事実は残るので、
 * INNER JOIN にすると記録が一覧から消える。
 *
 * created_at は ms 精度のため同一msがありうる(連続タップ等)。最終キーの
 * rowid desc で挿入順に倒し、同msでも後から入れた行を先にする。無ければ
 * 同msの2件の順序が未定義になり、統合後の時系列表示で並びが運で変わる。
 * place / importBatch と JOIN しているため、素の `rowid` では曖昧になる——
 * テーブル修飾で wine_encounter のものであることを明示する。
 */
export async function listWineEncounters(
	userId: string,
	drunkWineId: string,
	options: { drank?: boolean } = {},
): Promise<WineEncounterEntry[]> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	const conditions = [
		eq(wineEncounter.drunkWineId, drunkWineId),
		eq(wineEncounter.userId, userId),
		...(options.drank !== undefined
			? [eq(wineEncounter.drank, options.drank)]
			: []),
	];
	const rows = await db
		.select({
			...getTableColumns(wineEncounter),
			placeName: place.name,
			batchPhotoKeys: importBatch.photoKeys,
		})
		.from(wineEncounter)
		.leftJoin(place, eq(place.id, wineEncounter.placeId))
		.leftJoin(importBatch, eq(importBatch.id, wineEncounter.batchId))
		.where(and(...conditions))
		.orderBy(
			sql`${wineEncounter.occurredOn} is null`,
			desc(wineEncounter.occurredOn),
			desc(wineEncounter.createdAt),
			sql`${wineEncounter}."rowid" desc`,
		);
	return rows.map(toEncounterEntry);
}

/**
 * 既存の銘柄に体験記録を1件足す。`newPlace` が来たら場所も**同じ batch** で作る
 * (銘柄の新規登録・一括登録と同じ形)。場所だけ作られて記録が入らない、あるいは
 * その逆の中途半端な状態を残さない。
 *
 * 入力は `createWineEncounterInput` が関門(形の単一情報源は place/schema.ts)。
 * server fn・MCP は旧スキーマで検証済みの値を写し替えて渡すが、ここで改めて
 * 統合後の形で検証する——経路ごとに条件を書き散らさない(#177 / #185 と同じ類型)。
 */
export async function addWineEncounter(
	userId: string,
	drunkWineId: string,
	input: CreateWineEncounterInput,
): Promise<DrunkWineEntry> {
	const parsed = createWineEncounterInput.parse(input);
	await assertOwnsDrunkWine(userId, drunkWineId);
	await assertOwnsEncounterRefs(userId, parsed);
	// 重複名の関門は prepareNewPlace(場所を作る全経路の共通入口)が持つ。
	const newPlace = parsed.newPlace
		? await prepareNewPlace(userId, parsed.newPlace)
		: null;
	const statements: BatchStatement[] = [];
	if (newPlace) statements.push(db.insert(place).values(newPlace));
	statements.push(
		db.insert(wineEncounter).values(
			buildEncounterValues(
				userId,
				drunkWineId,
				// placeId と newPlace は zod が排他にしているので上書きの衝突は無い
				newPlace ? { ...parsed, placeId: newPlace.id } : parsed,
			),
		),
	);
	statements.push(recomputeDrunkWineAggregates(userId, drunkWineId));
	statements.push(selectEntry(userId, drunkWineId));
	return entryFromBatch(
		await db.batch(statements as [BatchStatement, ...BatchStatement[]]),
	);
}

/**
 * 所有する体験記録を引く。存在しない/他ユーザは同一エラー。
 * drank を指定すると種類の不一致も同一エラーにする(旧テーブルの分離と等価)。
 */
async function findOwnedEncounter(
	userId: string,
	encounterId: string,
	expected?: { drank: boolean },
) {
	const [row] = await db
		.select({
			id: wineEncounter.id,
			drunkWineId: wineEncounter.drunkWineId,
			drank: wineEncounter.drank,
		})
		.from(wineEncounter)
		.where(
			and(eq(wineEncounter.id, encounterId), eq(wineEncounter.userId, userId)),
		);
	if (!row) throw new NotFoundError("Entry not found");
	if (expected && row.drank !== expected.drank) {
		throw new NotFoundError("Entry not found");
	}
	return row;
}

/**
 * 体験記録1件を更新する文を組み立てる。全キーが未指定なら null を返す
 * (drizzle は空の SET を "No values to set" で拒否するため)。集計の再計算だけは
 * 呼び出し側が常に実行する — 冪等なので、整合が崩れたときの復旧手段になる。
 */
function buildEncounterUpdate(
	userId: string,
	encounterId: string,
	patch: Omit<UpdateWineEncounterInput, "id">,
) {
	// undefined = 変更しない / null = クリア。undefinedキーはdrizzleが無視する
	if (Object.values(patch).every((v) => v === undefined)) return null;
	return db
		.update(wineEncounter)
		.set({
			drank: patch.drank,
			// 追加時と同じく、drank=OFF の行に評価は残さない。トグルを倒した
			// だけで rating を送らない呼び出しがあっても不変条件が保たれる。
			rating:
				patch.drank === false && patch.rating === undefined
					? null
					: patch.rating,
			occurredOn: patch.occurredOn,
			price: patch.price,
			memo: patch.memo,
			placeId: patch.placeId,
			batchId: patch.batchId,
			photoIndex: patch.photoIndex,
			photoIndexes: patch.photoIndexes,
		})
		.where(
			and(eq(wineEncounter.id, encounterId), eq(wineEncounter.userId, userId)),
		);
}

/**
 * 体験記録1件を更新する。`newPlace` が来たら場所を作って `placeId` をそれに差し替える
 * ——追加時と同じく、場所の作成と記録の更新は同じ batch に積む。
 */
export async function updateWineEncounter(
	userId: string,
	input: UpdateWineEncounterInput,
): Promise<DrunkWineEntry> {
	// 追加時と同じく統合後の形で検証する(関門は place/schema.ts)。
	const {
		id,
		newPlace: newPlaceInput,
		...patch
	} = updateWineEncounterInput.parse(input);
	const target = await findOwnedEncounter(userId, id);
	await assertOwnsEncounterRefs(userId, patch);
	const newPlace = newPlaceInput
		? await prepareNewPlace(userId, newPlaceInput)
		: null;
	const update = buildEncounterUpdate(
		userId,
		id,
		// placeId と newPlace は zod が排他にしているので上書きの衝突は無い
		newPlace ? { ...patch, placeId: newPlace.id } : patch,
	);
	const recompute = recomputeDrunkWineAggregates(userId, target.drunkWineId);
	const read = selectEntry(userId, target.drunkWineId);
	const statements: BatchStatement[] = [
		...(newPlace ? [db.insert(place).values(newPlace)] : []),
		...(update ? [update] : []),
		recompute,
		read,
	];
	return entryFromBatch(
		await db.batch(statements as [BatchStatement, ...BatchStatement[]]),
	);
}

export async function deleteWineEncounter(
	userId: string,
	encounterId: string,
): Promise<DrunkWineEntry> {
	const target = await findOwnedEncounter(userId, encounterId);
	return entryFromBatch(
		await db.batch([
			db
				.delete(wineEncounter)
				.where(
					and(
						eq(wineEncounter.id, encounterId),
						eq(wineEncounter.userId, userId),
					),
				),
			recomputeDrunkWineAggregates(userId, target.drunkWineId),
			selectEntry(userId, target.drunkWineId),
		]),
	);
}

/**
 * MCP のレガシー引数(register/update の drank_on / rating / memo)専用。
 * 「最新の飲用記録(drank=1 の体験記録)を in-place で更新する」— 新規追加はしない。
 * MCP App の編集フォームは保存のたびに update_drunk_wine を投げるため、追加にすると
 * 保存を押すたびに tasting_count が増えてしまう。
 *
 * 飲用記録が0件のときは、非 null の値が1つでもあれば1件作る(全部 null なら no-op)。
 * null は「その列をクリア」の意で、行は消さない(旧セマンティクスは列のクリアで
 * あって記録の削除ではない)。
 */
export async function updateLatestDrankEncounter(
	userId: string,
	drunkWineId: string,
	patch: {
		occurredOn?: string | null;
		rating?: number | null;
		memo?: string | null;
	},
): Promise<DrunkWineEntry | null> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	const [latest] = await db
		.select({ id: wineEncounter.id })
		.from(wineEncounter)
		.where(
			and(
				eq(wineEncounter.drunkWineId, drunkWineId),
				eq(wineEncounter.userId, userId),
				eq(wineEncounter.drank, true),
			),
		)
		.orderBy(
			sql`${wineEncounter.occurredOn} is null`,
			desc(wineEncounter.occurredOn),
			desc(wineEncounter.createdAt),
			// 同msの created_at が並んだときは後から入れた行を最新にする
			// (LATEST_DRANK_ENCOUNTER_ORDER と同じ定義)。
			sql`rowid desc`,
		)
		.limit(1);

	if (!latest) {
		const hasValue = [patch.occurredOn, patch.rating, patch.memo].some(
			(v) => v !== undefined && v !== null,
		);
		if (!hasValue) return null;
		return addWineEncounter(userId, drunkWineId, {
			drank: true,
			occurredOn: patch.occurredOn ?? undefined,
			rating: patch.rating ?? undefined,
			memo: patch.memo ?? undefined,
		});
	}

	const update = buildEncounterUpdate(userId, latest.id, patch);
	const recompute = recomputeDrunkWineAggregates(userId, drunkWineId);
	const read = selectEntry(userId, drunkWineId);
	return entryFromBatch(
		await db.batch(update ? [update, recompute, read] : [recompute, read]),
	);
}

// ---- 互換アダプタ(旧 server fn・MCP 用) --------------------------------------
// 旧 wine_tasting / wine_sighting を読んでいた経路の互換層。UI は無変更のため、
// server fn(listWineTastings 等)はこのままの形で残し、内部では drank 条件付きで
// wine_encounter を読む(listWineTastings は drank=1、listWineSightings は
// drank=0 を返す)。PR2 で UI 統合とともに server fn を統合 API へ寄せる。
// 種類の不一致(drank=0 の行への飲用操作など)は旧テーブルの分離と等価に
// NotFound として扱う。

export async function listWineTastings(
	userId: string,
	drunkWineId: string,
): Promise<WineTastingEntry[]> {
	const encounters = await listWineEncounters(userId, drunkWineId, {
		drank: true,
	});
	return encounters.map((e) => ({
		id: e.id,
		drankOn: e.occurredOn,
		rating: e.rating,
		memo: e.memo,
		createdAt: e.createdAt,
		updatedAt: e.updatedAt,
	}));
}

export async function addWineTasting(
	userId: string,
	drunkWineId: string,
	input: CreateWineTastingInput,
): Promise<DrunkWineEntry> {
	return addWineEncounter(userId, drunkWineId, {
		drank: true,
		occurredOn: input.drankOn,
		rating: input.rating,
		memo: input.memo,
	});
}

export async function updateWineTasting(
	userId: string,
	input: UpdateWineTastingInput,
): Promise<DrunkWineEntry> {
	const { id, ...patch } = input;
	await findOwnedEncounter(userId, id, { drank: true });
	return updateWineEncounter(userId, {
		id,
		occurredOn: patch.drankOn,
		rating: patch.rating,
		memo: patch.memo,
	});
}

export async function deleteWineTasting(
	userId: string,
	tastingId: string,
): Promise<DrunkWineEntry> {
	await findOwnedEncounter(userId, tastingId, { drank: true });
	return deleteWineEncounter(userId, tastingId);
}

/**
 * MCP のレガシー引数(register/update の drank_on / rating / memo)専用の
 * 互換アダプタ。実体は updateLatestDrankEncounter。
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
	return updateLatestDrankEncounter(userId, drunkWineId, {
		occurredOn: patch.drankOn,
		rating: patch.rating,
		memo: patch.memo,
	});
}

export async function listWineSightings(
	userId: string,
	drunkWineId: string,
): Promise<WineSightingEntry[]> {
	const encounters = await listWineEncounters(userId, drunkWineId, {
		drank: false,
	});
	return encounters.map((e) => ({
		id: e.id,
		placeId: e.placeId,
		placeName: e.placeName,
		batchId: e.batchId,
		photoIndex: e.photoIndex,
		photoUrl: e.photoUrl,
		photoUrls: e.photoUrls,
		seenOn: e.occurredOn,
		price: e.price,
		memo: e.memo,
		createdAt: e.createdAt,
		updatedAt: e.updatedAt,
	}));
}

export async function addWineSighting(
	userId: string,
	drunkWineId: string,
	input: CreateWineSightingInput,
): Promise<DrunkWineEntry> {
	return addWineEncounter(userId, drunkWineId, {
		drank: false,
		occurredOn: input.seenOn,
		price: input.price,
		memo: input.memo,
		placeId: input.placeId,
		batchId: input.batchId,
		photoIndex: input.photoIndex,
		photoIndexes: input.photoIndexes,
		newPlace: input.newPlace,
	});
}

export async function updateWineSighting(
	userId: string,
	input: UpdateWineSightingInput,
): Promise<DrunkWineEntry> {
	const { id, newPlace, seenOn, ...patch } = input;
	await findOwnedEncounter(userId, id, { drank: false });
	return updateWineEncounter(userId, {
		id,
		...(newPlace ? { newPlace } : {}),
		...patch,
		...(seenOn !== undefined ? { occurredOn: seenOn } : {}),
	});
}

export async function deleteWineSighting(
	userId: string,
	sightingId: string,
): Promise<DrunkWineEntry> {
	await findOwnedEncounter(userId, sightingId, { drank: false });
	return deleteWineEncounter(userId, sightingId);
}

/**
 * 「飲んだ」操作。drank=1 の体験記録の追加と status='finished' を1操作で行う。
 * 本数を管理しない以上これが既定として自然で、ストックが残っている場合は
 * 編集画面から owned に戻せる。2軸を同時に動かす唯一の経路をここに閉じる。
 */
export async function markWineDrunk(
	userId: string,
	drunkWineId: string,
	input?: CreateWineTastingInput,
): Promise<DrunkWineEntry> {
	await assertOwnsDrunkWine(userId, drunkWineId);
	return entryFromBatch(
		await db.batch([
			db.insert(wineEncounter).values(
				buildEncounterValues(userId, drunkWineId, {
					drank: true,
					occurredOn: input?.drankOn ?? jstDayKey(new Date()),
					rating: input?.rating,
					memo: input?.memo,
				}),
			),
			recomputeDrunkWineAggregates(userId, drunkWineId, { status: "finished" }),
			selectEntry(userId, drunkWineId),
		]),
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

/**
 * R2掃除の対象キー(原寸+サムネイル)を組み立てる。子テーブルと旧列の**和集合**で見る。
 *
 * 二重化が保たれていれば両者は一致するが、デプロイの「新スキーマ×旧コード」の
 * window では旧列にだけ載る写真がありうる。掃除漏れ(R2に孤児が残り続ける)より
 * 余分に消そうとするほうが害が小さく、存在しないキーの delete はR2側が無視する。
 * 削除経路(deleteDrunkWine / deleteDrunkWines / undoImportBatch)はすべてここを通す。
 */
export function photoCleanupKeys(
	childKeys: string[],
	legacyKeys: string[],
): string[] {
	const keys = [...new Set([...childKeys, ...legacyKeys])];
	return keys.length > 0 ? [...keys, ...keys.map(thumbKeyForPhotoKey)] : [];
}

export async function cleanupPhotoObjects(
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
	// 子テーブル行は消える前にキーを拾う(R2実体の掃除用)。旧列との和集合で
	// 掃除する理由は photoCleanupKeys を参照。
	const childKeys = (await listEntryPhotos(userId, id)).map(
		(photo) => photo.key,
	);
	// 子テーブル行は ON DELETE CASCADE でも消えるが、明示削除も行う——掃除の対象を
	// 確定させる読み取りと対にし、FK 強制の有無に依らず行を残さない。
	const results = await db.batch([
		db
			.delete(winePhoto)
			.where(and(eq(winePhoto.drunkWineId, id), eq(winePhoto.userId, userId))),
		db
			.delete(drunkWine)
			.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)))
			.returning({ photoKeys: drunkWine.photoKeys }),
	]);
	const [row] = results[1] as { photoKeys: string[] }[];
	if (!row) throw new NotFoundError("Entry not found");
	// R2は複数キー一括削除に対応(存在しないキーは無視される)。サムネイル(#237)も一緒に消す。
	// D1の行は既に消えているので、掃除の失敗で「削除できなかった」と返さない(#249)。
	await cleanupPhotoObjects(photoCleanupKeys(childKeys, row.photoKeys), {
		userId,
		entryId: id,
		phase: "entry-deleted",
	});
}

/**
 * 複数エントリのまとめ削除(Issue #363 案B: /cellar 一覧のチェックボックス選択)。
 * 所有権を持たない/存在しない id は黙って無視し(単体削除の Entry not found とは違い、
 * 選択リストに他ユーザの id が混ざることは無いため、部分一致でも呼び出し側のミスとは
 * 見なさない)、実際に消えた件数を返す。
 *
 * D1書き込みは `drunk_wine` 1テーブルへの delete のみで、`wine_encounter` は
 * ON DELETE CASCADE(schema.ts)で連動して消える。写真は
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
	// deleteDrunkWine と同じく、cascade で消える前に子テーブルのキーを拾う。
	const photoMap = await listEntryPhotosBulk(userId, uniqueIds);
	const statements: BatchStatement[] = [];
	for (let i = 0; i < uniqueIds.length; i += ID_CHUNK_SIZE) {
		const chunk = uniqueIds.slice(i, i + ID_CHUNK_SIZE);
		// 子テーブル行の明示削除(deleteDrunkWine と同じ理由)。親より前に積む。
		statements.push(
			db
				.delete(winePhoto)
				.where(
					and(
						inArray(winePhoto.drunkWineId, chunk),
						eq(winePhoto.userId, userId),
					),
				),
		);
		statements.push(
			db
				.delete(drunkWine)
				.where(and(inArray(drunkWine.id, chunk), eq(drunkWine.userId, userId)))
				.returning({ photoKeys: drunkWine.photoKeys }),
		);
	}
	const results = await db.batch(
		statements as [BatchStatement, ...BatchStatement[]],
	);
	// 文は[子削除, 親削除(RETURNING)]の対で積んだので、奇数番目の結果だけが
	// 実際に消えた行(旧列の R2 掃除用・deletedCount 用)。
	const rows = results.filter((_, index) => index % 2 === 1).flat() as {
		photoKeys: string[];
	}[];
	const childKeys = [...photoMap.values()].flat().map((photo) => photo.key);
	const legacyKeys = rows.flatMap((row) => row.photoKeys);
	const keys = photoCleanupKeys(childKeys, legacyKeys);
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
 * 「その場所で出会った銘柄」の条件。体験記録は 1:N なので EXISTS で畳む
 * (JOIN すると同じ場所で複数回出会った銘柄が重複行になり、ページングの件数が狂う)。
 *
 * 飲んだ回にも場所が付くようになったため、drank では絞らない。「この店で飲んだ
 * ワイン」が一覧の場所フィルタから漏れていたのが、統合で直る副次効果の1つ。
 *
 * pure 版の対応物は置かない。所有状態のチップ(filter.ts)と違い、この軸は
 * wine_encounter を読まないと判定できず、クライアント側に同じ述語を置く用途が無い。
 */
function placeCondition(placeId: string) {
	return sql`exists (select 1 from ${wineEncounter} where ${wineEncounter.drunkWineId} = ${drunkWine.id} and ${wineEncounter.placeId} = ${placeId})`;
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
			lastRating: latestDrankEncounterValue<number>(wineEncounter.rating),
			lastMemo: latestDrankEncounterValue<string>(wineEncounter.memo),
		})
		.from(drunkWine)
		.where(and(...conditions))
		.orderBy(desc(drunkWine.createdAt), desc(drunkWine.id));

	// +1件多く読んで「次があるか」を判定する(別途 COUNT を撃たない)
	const rows = await (limit == null ? query : query.limit(limit + 1));
	const photoMap = await listEntryPhotosBulk(
		userId,
		rows.map((row) => row.id),
	);
	const entries = rows.map((row) => toEntry(row, photoMap.get(row.id) ?? []));
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
			lastRating: latestDrankEncounterValue<number>(wineEncounter.rating),
			lastMemo: latestDrankEncounterValue<string>(wineEncounter.memo),
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
	const photoMap = await listEntryPhotosBulk(
		userId,
		rows.map((row) => row.id),
	);
	return rows.map((row) => toEntry(row, photoMap.get(row.id) ?? []));
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
			lastRating: latestDrankEncounterValue<number>(wineEncounter.rating),
			lastMemo: latestDrankEncounterValue<string>(wineEncounter.memo),
		})
		.from(drunkWine)
		.where(eq(drunkWine.userId, userId))
		.orderBy(desc(drunkWine.createdAt))
		.limit(1);
	return {
		tastedCount: countRow?.tasted ?? 0,
		totalCount: countRow?.total ?? 0,
		latest: latestRow
			? toEntry(latestRow, await listEntryPhotos(userId, latestRow.id))
			: null,
	};
}

export async function getDrunkWine(
	userId: string,
	id: string,
): Promise<DrunkWineEntry> {
	const [row] = await selectEntry(userId, id);
	if (!row) throw new NotFoundError("Entry not found");
	return toEntry(row, await listEntryPhotos(userId, id));
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

// ---- 写真集合の行単位更新 (Issue #645) ---------------------------------------
// 写真は `winePhoto` 子テーブルの行で持ち、追加・削除は1行の INSERT / DELETE にする。
// #637 のつなぎの楽観ロック(配列丸ごとの compare-and-swap)は外した:
// 並行する引き継ぎ(append)が足した行を sync が消すことは、DELETE を「起点にあった
// 行ID指定」にすることで起きない。append 同士も別行の INSERT なので失わない。
// sync は書き込み直前に子テーブルを読み直し、起点以降に増えた行を末尾に残す
// (UI の layout 外の追加を消さないため)。旧列への二重化だけが丸ごと書戻しだが、
// 正本は子テーブルなので競合しても表示は壊れない。

/**
 * エントリの写真集合を layout(最終並び順)へ全置換で同期する。追加・削除・並べ替え・
 * 差し替えを1回で反映する。新規はR2へ保存し、起点にあって残らない行は削除して
 * 残骸を残さない。layout の existing キーは子テーブルの現在の集合に属するもののみ
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
	const [parent] = await db
		.select({
			photoKeys: drunkWine.photoKeys,
			photoKinds: drunkWine.photoKinds,
		})
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!parent) throw new NotFoundError("Entry not found");
	// 旧列だけのキーがあれば子テーブルへ寄せてから、以降低列を見ない。
	const base = await repairLegacyPhotos(
		userId,
		id,
		parent.photoKeys,
		resolveStoredPhotoKinds(parent.photoKeys, parent.photoKinds),
	);
	const baseByKey = new Map(base.map((row) => [row.r2Key, row]));
	for (const item of layout) {
		if (item.kind === "existing" && !baseByKey.has(item.key)) {
			throw new BadRequestError("Unknown photo");
		}
	}
	// 既存キーの由来は子テーブルから写す(未知値は bottle に倒れる)。
	// 新規追加は利用者自身の撮影 = bottle。
	const kindByKey = new Map(
		base.map((row) => [row.r2Key, normalizeWinePhotoKind(row.kind)]),
	);
	// layout 順のスロット(既存キー or 今回putした新規キー)は後段で組み立てる。

	// 新規をR2へ保存しつつ、layout 順のスロット(既存キー or 今回putした新規キー)を
	// 組み立てる。put途中で失敗したら今回put分を巻き戻す
	const putKeys: string[] = [];
	const layoutSlots: string[] = [];
	const newSlotKeys = new Set<string>();
	try {
		for (const item of layout) {
			if (item.kind === "existing") {
				layoutSlots.push(item.key);
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
			layoutSlots.push(key);
			newSlotKeys.add(key);
			// 以降の追加(フォーム・MCP からの撮影)は利用者自身の写真 = bottle。
			// web 由来は adoptWebPhotos 経路でのみ付く。
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

	// R2へのputを挟んだ間に並行する引き継ぎ(append)が足した行を拾うため、
	// 書き込む直前に子テーブルを読み直す。起点の読み直しと違い、ここは
	// 「layout 外で増えた行」の検出が目的。
	const fresh = await db
		.select({
			id: winePhoto.id,
			r2Key: winePhoto.r2Key,
			kind: winePhoto.kind,
			position: winePhoto.position,
		})
		.from(winePhoto)
		.where(and(eq(winePhoto.drunkWineId, id), eq(winePhoto.userId, userId)))
		.orderBy(asc(winePhoto.position));
	const freshSet = new Set(fresh.map((row) => row.r2Key));
	const freshKindByKey = new Map(
		fresh.map((row) => [row.r2Key, normalizeWinePhotoKind(row.kind)]),
	);
	// 並行して消された layout キーは蘇らせない(R2実体は既に消えている)。
	const keptSlots = layoutSlots.filter(
		(key) => newSlotKeys.has(key) || freshSet.has(key),
	);
	// layout の起点以降に増えたキー = 並行する引き継ぎの追加。末尾に残す。
	const baseKeySet = new Set(base.map((row) => row.r2Key));
	const keptSet = new Set(keptSlots);
	const mergedExtras = fresh
		.map((row) => row.r2Key)
		.filter((key) => !baseKeySet.has(key) && !keptSet.has(key));
	const room = Math.max(0, MAX_PHOTOS_PER_ENTRY - keptSlots.length);
	if (mergedExtras.length > room) {
		logWarn("drunk wine photo sync dropped concurrent additions", {
			userId,
			entryId: id,
			droppedCount: mergedExtras.length - room,
		});
	}
	const nextKeys = [...keptSlots, ...mergedExtras.slice(0, room)];
	for (const key of nextKeys) {
		if (!kindByKey.has(key)) {
			kindByKey.set(key, freshKindByKey.get(key) ?? "bottle");
		}
	}
	const nextKinds = nextKeys.map((key) => kindByKey.get(key) ?? "bottle");

	const freshIdByKey = new Map(fresh.map((row) => [row.r2Key, row.id]));
	const freshPositionById = new Map(fresh.map((row) => [row.id, row.position]));
	const nextSet = new Set(nextKeys);
	const statements: BatchStatement[] = [];
	// 起点にあって最終集合に残らない行だけを消す(削除・差し替えの反映)。
	// 行ID指定なので、並行する引き継ぎが足した行には触れない。
	const removedBase = base.filter((row) => !nextSet.has(row.r2Key));
	for (let i = 0; i < removedBase.length; i += ID_CHUNK_SIZE) {
		const chunk = removedBase.slice(i, i + ID_CHUNK_SIZE);
		statements.push(
			db.delete(winePhoto).where(
				and(
					eq(winePhoto.drunkWineId, id),
					eq(winePhoto.userId, userId),
					inArray(
						winePhoto.id,
						chunk.map((row) => row.id),
					),
				),
			),
		);
	}
	// 最終集合の順序を position へ書き戻す。新規putは INSERT、既存は変わった行だけ UPDATE。
	for (const [index, key] of nextKeys.entries()) {
		const existingId = freshIdByKey.get(key);
		if (existingId) {
			if (freshPositionById.get(existingId) !== index) {
				statements.push(
					db
						.update(winePhoto)
						.set({ position: index })
						.where(
							and(eq(winePhoto.id, existingId), eq(winePhoto.userId, userId)),
						),
				);
			}
			continue;
		}
		statements.push(
			db.insert(winePhoto).values({
				id: crypto.randomUUID(),
				drunkWineId: id,
				userId,
				r2Key: key,
				kind: kindByKey.get(key) ?? "bottle",
				position: index,
			}),
		);
	}
	// 旧列への二重化(次PRでDROPするまでのつなぎ。正本は子テーブル)。
	statements.push(
		db
			.update(drunkWine)
			.set({ photoKeys: nextKeys, photoKinds: nextKinds })
			.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId))),
	);
	try {
		await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
	} catch (e) {
		// D1が書けなかった = 子テーブル・旧列のどちらも変わっていない。今回putした
		// R2オブジェクトは誰からも参照されないので掃除し、元例外を通す。
		// 存在確認とここまでの間にエントリが消えた場合は NotFound に倒す。
		await cleanupPhotoObjects(putKeys, {
			userId,
			entryId: id,
			phase: "sync-rollback",
			originalErr: e,
		});
		await assertOwnsDrunkWine(userId, id);
		throw e;
	}
	// 起点にあって最終集合に残らないキーのR2実体を掃除する(削除・差し替えを一括反映)。
	// サムネイルは原寸に追随させる(消し忘れるとR2に孤児が残り続ける)。
	const removedKeys = removedBase.map((row) => row.r2Key);
	await cleanupPhotoObjects(
		removedKeys.length > 0
			? [...removedKeys, ...removedKeys.map(thumbKeyForPhotoKey)]
			: [],
		{ userId, entryId: id, phase: "orphan-sweep" },
	);

	// 写真の更新は飲用記録を変えないが、最新1件の評価・メモは列に持たないので
	// 返却用に読み直す(R2 の後始末が済んでから)。
	return getDrunkWine(userId, id);
}

/**
 * 既に R2 にある写真キーをエントリの写真集合の**末尾に足す**(#474)。
 *
 * エチケット解析ジョブが解析のために保存した写真を、その結果を記録したワインの写真
 * として引き継ぐための入口。**`syncDrunkWinePhotos` では出来ない**——あちらは
 * 「layout の existing キーは対象エントリの現在の集合に属するもののみ許可」して
 * 任意キーの注入を防いでおり、まだそのエントリのものでないキーは弾かれる。
 * ここは呼び出し側(label-job-service)がジョブの所有者を確認した上で使う内部経路で、
 * **クライアントからは到達できない**。
 *
 * バイト列をコピーしない。R2キーは `wines/{userId}/…` で、配信の認可も退会時の一括削除も
 * userId までしか見ていない(`signed-url.ts` / `user-deletion-service.ts`)ので、
 * 2つ目のセグメントがジョブIDのままでも所有と掃除は成立する。エントリ削除は保存済みキーを
 * 消す実装なので、引き継いだキーもそのまま消える。
 *
 * 上限(`MAX_PHOTOS_PER_ENTRY`)を超えるぶんは**足さずに捨てる**。引き継ぎは付随的な処理で、
 * ここで例外にすると「記録は出来たのに写真のせいで失敗した」ことになる。捨てたキーは
 * 呼び出し側が掃除できるよう返す。
 */

export async function appendDrunkWinePhotoKeys(
	userId: string,
	id: string,
	keys: string[],
): Promise<{ entry: DrunkWineEntry; adopted: string[]; dropped: string[] }> {
	const [parent] = await db
		.select({
			photoKeys: drunkWine.photoKeys,
			photoKinds: drunkWine.photoKinds,
		})
		.from(drunkWine)
		.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId)));
	if (!parent) throw new NotFoundError("Entry not found");
	// 旧列だけのキーがあれば子テーブルへ寄せてから、以降旧列を見ない。
	const current = await repairLegacyPhotos(
		userId,
		id,
		parent.photoKeys,
		resolveStoredPhotoKinds(parent.photoKeys, parent.photoKinds),
	);

	// 既に持っているキーは足さない(二重に開いた・再送された回で重複させない)。
	// unique 制約(`wine_photo_entry_r2_key_uq`)が最後の関門なので、読み直しと
	// 書き込みの間に並行 append が割り込んでも行は増えない(INSERT OR IGNORE)。
	const currentKeys = current.map((row) => row.r2Key);
	const currentSet = new Set(currentKeys);
	const currentKinds = current.map((row) => normalizeWinePhotoKind(row.kind));
	const incoming = keys.filter((key) => !currentSet.has(key));
	const room = Math.max(0, MAX_PHOTOS_PER_ENTRY - current.length);
	const adopted = incoming.slice(0, room);
	const dropped = incoming.slice(room);

	if (adopted.length === 0) {
		return { entry: await getDrunkWine(userId, id), adopted, dropped };
	}
	// 解析ジョブの引き継ぎは利用者自身が撮った写真 = bottle。
	// 旧列への二重化も子テーブル由来の集合そのまま(repair 済みなので旧列だけの
	// キーは残っていない)。
	const nextKeys = [...currentKeys, ...adopted];
	const nextKinds: PhotoKind[] = [
		...currentKinds,
		...adopted.map(() => "bottle" as PhotoKind),
	];
	await db.batch([
		db
			.insert(winePhoto)
			.values(
				buildWinePhotoValues(
					userId,
					id,
					adopted.map((key) => ({ key, kind: "bottle" as PhotoKind })),
					current.length,
				),
			)
			.onConflictDoNothing({
				target: [winePhoto.drunkWineId, winePhoto.r2Key],
			}),
		db
			.update(drunkWine)
			.set({ photoKeys: nextKeys, photoKinds: nextKinds })
			.where(and(eq(drunkWine.id, id), eq(drunkWine.userId, userId))),
	]);
	return { entry: await getDrunkWine(userId, id), adopted, dropped };
}

/**
 * db.batch に積める文の型。db.batch は「1件以上」をタプルで要求するので、
 * 件数が実行時に決まるこの経路では配列で組み立ててから最後にタプルへ寄せる。
 */
export type BatchStatement = Parameters<typeof db.batch>[0][number];

/**
 * 集計キャッシュの一括再計算。**1文で全対象を更新する**が、id を ID_CHUNK_SIZE で
 * 分割して積むのは D1 のバインド変数上限に触れないため(1回の一括登録は最大
 * MAX_ITEMS_PER_IMPORT 件 = 80件になりうる)。式は単体経路と同じものを使う。
 */
export function recomputeDrunkWineAggregatesBulk(
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
					encounterCount: ENCOUNTER_COUNT_EXPR,
					lastEncounteredOn: MAX_ENCOUNTERED_ON_EXPR,
				})
				.where(and(eq(drunkWine.userId, userId), inArray(drunkWine.id, chunk))),
		);
	}
	return statements;
}

// 一括登録サブドメインは import-batch-service.ts へ分離(Issue #406)。
// bulkRegisterFromScan / undoImportBatch / listImportBatches / saveImportBatchPhotos
// ほか一式はあちらに移動し、結合点のヘルパは上記の export を参照する。
