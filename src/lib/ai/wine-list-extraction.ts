import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { PRICE_MAX, PRICE_MIN } from "#/lib/drunk-wine/schema";
import type { WineStatus } from "#/lib/drunk-wine/status";
import { getAop } from "#/lib/wine/service";
import { AI_WINE_LIST_MAX_WINES } from "./config";
import {
	buildKnownListsSection,
	buildLabelSuggestions,
	extractJsonPayload,
	type LabelExtraction,
	type LabelSuggestions,
	labelExtractionShape,
	matchAop,
	normalizeLabelText,
	parseImageDataUrl,
	toLabelExtraction,
} from "./label-extraction";

// レストランのワインリスト・ショップの陳列など「複数銘柄が写った複数の写真」から
// 銘柄の配列を抽出する純ロジック(Issue #358)。指示文・応答パース・重複統合・
// 既存セラーとの突合・見積を DB/env 非依存で切り出し、単体テスト可能にする
// (Anthropic API の実行とクレジット処理は ai-service 側)。
//
// エチケット解析(label-extraction.ts)との違い:
//  - 1解析 = N銘柄。出力は配列で、写真をまたいだ同一銘柄の統合(distinct)が要る
//  - 銘柄ごとの由来(どの写真に写っていたか)を photo_indexes として保持する
//  - リストの売値(price)を読む。銘柄マスタ側ではなく「その店での売値」なので、
//    保存先は目撃記録(wine_sighting.price)になる
//  - web検索での裏取りはしない(銘柄数 × 検索でコストが発散する。裏取りしたい銘柄は
//    登録後に既存の単体エチケット解析を使う住み分け)
//
// 銘柄1件ぶんのフィールドの形と揺れの吸収は label-extraction.ts と共有する
// (labelExtractionShape / toLabelExtraction)。ここで書き直すと、片方の経路だけ
// 「vintage が文字列で返ってきたら捨てる」といった差が生まれる。

/**
 * 出力上限で応答が打ち切られたときのメッセージ。**両経路が同じ文言を投げる**
 * (Claude は stop_reason="max_tokens"、GPT は status="incomplete" として表面化する)。
 * 打ち切られた応答は JSON が途中で切れており、パースに回すと「形式が不正」という
 * 無関係な例外になる。銘柄が多すぎることが原因だとユーザに分かる形で返し、
 * escape hatch(写真を分けて解析)を案内する。
 */
export const WINE_LIST_TRUNCATED_ERROR_MESSAGE =
	"写真に写っているワインが多すぎて、解析結果を最後まで受け取れませんでした。写真を分けて解析してください。";

/** モデルが返す銘柄1件の形(labelExtractionShape + 一括抽出に固有の2項目)。 */
const wineListItemSchema = z.object({
	...labelExtractionShape,
	/** リスト記載の価格。数値化できなければ null。 */
	price: z
		.union([z.number(), z.string()])
		.transform((v) => {
			// "3,800円" / "¥3800" のような表記も拾う(桁区切り・通貨記号を落とす)
			const n =
				typeof v === "number"
					? v
					: Number.parseInt(v.replace(/[^0-9]/g, ""), 10);
			return Number.isFinite(n) ? Math.trunc(n) : null;
		})
		.nullish()
		.catch(null),
	/** この銘柄が写っていた写真の番号(0始まり)。範囲外・重複はパース時に落とす。 */
	photo_indexes: z
		.union([z.array(z.union([z.number(), z.string()])), z.number(), z.string()])
		.transform((v) => (Array.isArray(v) ? v : [v]))
		.nullish()
		.catch([]),
});

/**
 * 写真群が何を写しているか。
 *
 * - `single_wine`: 全ての写真が**同じ1本のワイン**(ボトル・エチケット・裏ラベル・
 *   箱・ネックタグ)だけを写している
 * - `wine_list`: それ以外(飲食店のリスト、ショップの陳列・棚、複数銘柄)
 *
 * 判定できなかった回は `wine_list` に寄せる。一括登録がこの機能の既定の流れで、
 * 誤って単体登録へ飛ばすと、写した他の銘柄が黙って落ちるため。
 */
export type WineListSubject = "single_wine" | "wine_list";

/** モデル出力(全体)の受け取り側スキーマ。銘柄配列・被写体の種別・打ち切りフラグ。 */
const wineListResponseSchema = z.object({
	wines: z.array(wineListItemSchema).nullish().catch([]),
	/**
	 * 被写体の種別。未知の文字列・欠落は null にして、呼び出し側で既定
	 * (`wine_list`)へ寄せる。
	 */
	subject: z
		.union([z.literal("single_wine"), z.literal("wine_list")])
		.nullish()
		.catch(null),
	/** 出力上限などで列挙しきれなかった銘柄があるか。真偽値以外は false に寄せる。 */
	truncated: z.boolean().nullish().catch(false),
});

/** 抽出された銘柄1件。エチケット解析の抽出結果 + 一括抽出に固有の由来情報。 */
export interface WineListItem extends LabelExtraction {
	/** リスト記載の売値(円)。範囲外・未記載は undefined。 */
	price?: number;
	/** この銘柄が写っていた写真の番号(0始まり・昇順・重複なし)。 */
	photoIndexes: number[];
}

export interface WineListParseResult {
	wines: WineListItem[];
	/**
	 * 写真群の被写体。`single_wine` のとき、UI は一括登録のレビューではなく
	 * 単体の「ワインを記録」へ案内する(Issue #416)。
	 */
	subject: WineListSubject;
	/**
	 * 列挙しきれなかった銘柄があるか。モデルの自己申告(truncated)と、こちらの
	 * 件数上限による切り捨ての**論理和**。UI は「写真を分けて再解析」を案内する。
	 */
	truncated: boolean;
}

/**
 * モデルへの指示文。出力形式を強制する仕組み(guided_json / structured outputs)が
 * 使えない Claude 経路なので、形はここで規範として書く。末尾にマスタ名の一覧を
 * 同梱するのはエチケット解析と同じグラウンディング(SSOT: buildKnownListsSection)。
 *
 * 写真番号は buildWineListMessages が画像の直前に "写真 N" のテキストブロックを
 * 挟むことで対応づける。
 */
export function buildWineListPrompt(photoCount: number): string {
	return [
		"これは飲食店のワインリスト、ワインショップの陳列・棚・ポップ、または1本のワインのボトル・エチケット(ラベル)を撮影した写真です",
		`(全${photoCount}枚。各写真の直前に「写真 N」と番号を記載しています)。`,
		"写真に写っているワインの銘柄をすべて列挙し、最後にJSONオブジェクトだけを出力してください。",
		"",
		"1. すべての写真を読み、記載されているワインを1銘柄ずつ拾う。ヘッダー・グラスワインの区分見出し・店名などワインの銘柄でないものは拾わない。",
		"2. **同じ銘柄が複数の写真に写っている場合は1件に統合する**。生産者・ワイン名・ヴィンテージがすべて一致するものを同一銘柄とみなし、photo_indexes に写っていた写真番号をすべて入れる。ヴィンテージが違うものは別の銘柄として分ける。",
		"3. 写真から読み取れない項目は null にする。推測で創作しない。知識で補完しない(裏取りはこの解析では行わない)。",
		"4. 出力するJSONは次の形にする:",
		'   - "wines": 銘柄の配列。各要素は',
		'     - "wine_name": ワイン名(キュヴェ名等を含む。原語のまま)。読めなければ null',
		'     - "producer": 生産者/ドメーヌ/シャトー名。読めなければ null',
		'     - "vintage": 西暦の整数(例: 2020)。記載が無い/NV(ノンヴィンテージ)なら null',
		'     - "appellation": 原産地呼称(AOC/AOP/DOC/DOCG など)。下の既知リストに該当があればその表記を一字一句そのまま使う。読めなければ null',
		'     - "region": 地域名(例: Bourgogne, Toscana)。読めなければ null',
		'     - "country": 生産国(例: France, Italy)。読めなければ null',
		'     - "grape_varieties": 品種名の文字列配列。記載が無ければ空配列。下の既知リストに該当があればその表記を使う',
		'     - "price": リスト記載の価格を整数(日本円)で。グラスとボトルが併記されていればボトルの価格。記載が無ければ null',
		'     - "photo_indexes": この銘柄が写っていた写真番号(0始まり)の配列',
		'   - "subject": 写真群の被写体。**すべての写真が同じ1本のワインだけを写している**場合(ボトル単体・エチケット・裏ラベル・箱・ネックタグのクローズアップなど)は "single_wine"、飲食店のワインリスト・ショップの陳列や棚・複数の銘柄が写っている場合は "wine_list"',
		'   - "truncated": 列挙しきれなかった銘柄が残っている場合は true、すべて列挙できたなら false',
		'5. subject の判定は迷ったら "wine_list" にする。1本のワインだと確信できる場合にだけ "single_wine" にする。',
		"6. 銘柄数が多くても省略・要約しない。どうしても出力が長くなりすぎる場合のみ途中で打ち切り、その場合は truncated を true にする。",
		"7. JSONの前後に説明文・コードフェンスを書かない。",
		"",
		buildKnownListsSection(),
	].join("\n");
}

/**
 * 指示文 + 全写真を1つのユーザーメッセージに組み立てる。**写真ごとに直前へ
 * 「写真 N」のテキストブロックを挟む**のが要点で、これが無いとモデルは
 * photo_indexes を当て推量で埋める(どの写真で見かけたか = 目撃記録の由来が壊れる)。
 *
 * data URI であることの強制は parseImageDataUrl が兼ねる(HTTP URL を渡させない
 * 境界。エチケット解析の高精度経路と同じ)。
 */
export function buildWineListMessages(
	imageDataUrls: string[],
): Anthropic.MessageParam[] {
	const content: Anthropic.ContentBlockParam[] = [
		{ type: "text", text: buildWineListPrompt(imageDataUrls.length) },
	];
	for (const [index, dataUrl] of imageDataUrls.entries()) {
		const { mediaType, data } = parseImageDataUrl(dataUrl);
		content.push({ type: "text", text: `写真 ${index}` });
		content.push({
			type: "image",
			source: {
				type: "base64",
				// クライアントは jpeg/png/webp 等に限定して送る(validateDeclaredPhotoFiles)
				media_type: mediaType as "image/jpeg",
				data,
			},
		});
	}
	return [{ role: "user", content }];
}

/**
 * 写真番号の配列を正規化する。0..photoCount-1 の整数だけを残し、重複を潰して昇順に
 * 並べる。**モデルは範囲外の番号(1始まりで数える等)を返しうる**ので、ここで落として
 * おかないと wine_sighting.photoIndex の検証(0..MAX_PHOTOS_PER_IMPORT_BATCH-1)を
 * すり抜けた値が保存経路へ流れる。
 */
function normalizePhotoIndexes(
	values: Array<number | string>,
	photoCount: number,
): number[] {
	const out = new Set<number>();
	for (const raw of values) {
		const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
		if (!Number.isFinite(n)) continue;
		const index = Math.trunc(n);
		if (index < 0 || index >= photoCount) continue;
		out.add(index);
	}
	return [...out].sort((a, b) => a - b);
}

/**
 * モデルの生出力を銘柄配列にパースする。件数上限(AI_WINE_LIST_MAX_WINES)を超えた
 * ぶんは切り捨てて truncated を立てる。解釈できない場合は throw(呼び出し側で
 * クレジット返却の上エラー応答にする)。
 *
 * @param photoCount 渡した写真の枚数。photo_indexes の範囲検証に使う。
 */
export function parseWineListResponse(
	raw: unknown,
	photoCount: number,
): WineListParseResult {
	const result = wineListResponseSchema.safeParse(extractJsonPayload(raw));
	if (!result.success) {
		throw new Error("AIの応答の形式が不正です");
	}
	const rawWines = result.data.wines ?? [];
	const wines: WineListItem[] = rawWines
		.slice(0, AI_WINE_LIST_MAX_WINES)
		.map((w) => ({
			...toLabelExtraction(w),
			price:
				w.price != null && w.price >= PRICE_MIN && w.price <= PRICE_MAX
					? w.price
					: undefined,
			photoIndexes: normalizePhotoIndexes(w.photo_indexes ?? [], photoCount),
		}))
		// 名前も生産者も呼称も読めなかった行は、レビュー画面で編集する取っ掛かりが
		// 無く、そのまま登録すると名無しのエントリになる。落とす。
		.filter((w) => !!(w.wineName || w.producer || w.appellation));
	return {
		wines,
		// 未指定・未知の値は既定の一括登録(wine_list)に寄せる。**打ち切りが起きた
		// 回も一括扱いにする**——列挙しきれないほど銘柄があった写真を単体登録へ
		// 飛ばすと、残りの銘柄を登録する導線ごと消える。
		subject:
			result.data.subject === "single_wine" && !result.data.truncated
				? "single_wine"
				: "wine_list",
		truncated:
			result.data.truncated === true ||
			rawWines.length > AI_WINE_LIST_MAX_WINES,
	};
}

/**
 * 銘柄の同一性キー(正規化済み)。「生産者 + ワイン名」の正規化形とヴィンテージで
 * 同一銘柄を判定する。**バッチ内の統合と既存セラーとの突合が同じキーを使う**ことが
 * 重要で、別々に書くと「バッチ内では別物、既存とは同一」のような矛盾した扱いになる。
 *
 * ヴィンテージ違いを別銘柄にするのは、リストでは同じ銘柄の別年が並ぶことがあり、
 * 統合すると片方の情報が消えるため(Issue #358 の決定)。
 *
 * 名前も生産者も無い場合は空文字を返す。呼び出し側は空キーを「統合しない」印として
 * 扱う(空キー同士が全部1件に潰れると、読み取れなかった銘柄が消える)。
 */
export function wineIdentityKey(wine: {
	name?: string | null;
	producer?: string | null;
	vintage?: number | null;
}): string {
	const label = normalizeLabelText(
		[wine.producer ?? "", wine.name ?? ""].join(" "),
	);
	if (!label) return "";
	return `${label}|${wine.vintage ?? ""}`;
}

/**
 * 級付けの綴りの揺れを畳む。ワインリストは `1er Cru` と書き、マスタは
 * `Premier Cru` を持つ——**呼称名の除去は文字列一致でやる**ので、ここを揃えないと
 * `Chablis 1er Cru Montée de Tonnerre` から呼称部分が落ちない(実測で残った不一致)。
 */
function canonicalizeCruWords(normalized: string): string {
	return normalized.replace(/\b1er\b/g, "premier");
}

/**
 * 名前の末尾に付いたヴィンテージを落とす。モデルは `Chablis 1er Cru Montée de
 * Tonnerre 2021` のように**年を名前に含める回と含めない回**があり(実測)、年は
 * 別項目として持っているので名前側に残す意味が無い。1800〜2100 の4桁だけを対象に
 * する(`Barolo 1er` のような数字を巻き込まない)。
 */
function stripTrailingVintage(normalized: string): string {
	return normalized.replace(/\s(1[89]\d{2}|20\d{2}|2100)$/, "");
}

/**
 * 呼称名を取り除いた「銘柄を区別する部分」。`Barolo "Bussia"` と `"Bussia"` を
 * 同じ `bussia` に、`Gevrey-Chambertin Vieilles Vignes` と `Vieilles Vignes` を
 * 同じ `vieilles vignes` に畳む。名前が読めず呼称の日本語名で補われた回
 * (`シャブリ・プルミエ・クリュ`)は空文字になり、原語表記の回と一致する。
 *
 * AOPの正式名・短縮名・日本語名のいずれも落とす(モデルがどの表記を書くかは
 * 一定しない)。
 */
function distinctiveNamePart(
	name: string | null | undefined,
	aopId: string | null | undefined,
): string {
	const base = stripTrailingVintage(
		canonicalizeCruWords(normalizeLabelText(name ?? "")),
	);
	const aop = aopId ? getAop(aopId) : undefined;
	if (!base || !aop) return base;
	let out = base;
	for (const alias of [aop.name, aop.shortName, aop.nameJa]) {
		const normalized = canonicalizeCruWords(normalizeLabelText(alias));
		if (normalized) out = out.split(normalized).join(" ");
	}
	return out.trim().replace(/\s+/g, " ");
}

/**
 * 同一銘柄の判定に使う2段のキー(#435)。
 *
 * `strict` は従来どおり「生産者 + ワイン名 + ヴィンテージ」。**モデルが
 * 「ワイン名」と「呼称」をどう切り分けるかは実行ごとに変わる**ので、これだけでは
 * 同じ写真を解析し直しただけで別銘柄になる(実測で7銘柄中0〜6件しか一致しなかった)。
 *
 * `loose` は「生産者 + 解決済みAOP + 呼称名を除いた名前 + ヴィンテージ」。切り分けが
 * 変わっても**AOPの解決結果は変わらない**(`matchAop` は呼称とワイン名の両方を見る)
 * ため、揺れを吸収できる。
 *
 * 緩める方向なので、取り違えないよう2つの歯止めを置く:
 *  - AOPが解決できない銘柄には loose キーを作らない(空文字)
 *  - 生産者も「呼称を除いた名前」も空なら作らない。「生産者不明・キュヴェ名なしの
 *    バローロ2018」同士が別生産者でも一致してしまうため
 *
 * **生産者名がワイン名と同じ場合はキーから落とす**。ボルドーのシャトー物は
 * 生産者＝銘柄名で、モデルが producer を埋める回と空にする回が交互に出る
 * (`Château Gloria`)。名前側が同じなら生産者の有無で分かれる意味が無い。
 *
 * 同じAOP・同じ生産者・同じ年でもキュヴェが違えば `distinctiveNamePart` が違うので
 * 分かれる(例: `Gevrey-Chambertin Vieilles Vignes` と素の `Gevrey-Chambertin`)。
 *
 * **これでも畳めない揺れが残る**: 一方が畑名まで原語で書かれ(`Chablis 1er Cru
 * Montée de Tonnerre`)、もう一方は名前が読めずAOPの日本語名で補われた
 * (`モンテ・ド・トネル`)場合、呼称名を除いた残りが原語と日本語で食い違う。
 * ここを畳むには「残りが空なら生産者+AOP+年だけで一致とみなす」まで緩める必要が
 * あるが、それだと同じ村の別キュヴェを取り違えて**別のワインに目撃記録が付く**。
 * 分かれて重複が出るほうがレビュー画面で気付けるので、緩めない側に倒す。
 */
export interface WineIdentityKeys {
	strict: string;
	loose: string;
}

export function wineIdentityKeys(wine: {
	name?: string | null;
	producer?: string | null;
	vintage?: number | null;
	aopId?: string | null;
}): WineIdentityKeys {
	const strict = wineIdentityKey(wine);
	const producer = canonicalizeCruWords(
		normalizeLabelText(wine.producer ?? ""),
	);
	const distinctive = distinctiveNamePart(wine.name, wine.aopId);
	// 生産者＝銘柄名(シャトー物)なら生産者は情報を足していない。落として、
	// producer が埋まらなかった回と一致させる。
	const producerPart = producer === distinctive ? "" : producer;
	const loose =
		wine.aopId && (producer || distinctive)
			? `${producerPart}|${wine.aopId}|${distinctive}|${wine.vintage ?? ""}`
			: "";
	return { strict, loose };
}

/**
 * 抽出結果(サジェスト前)のAOP。**`buildLabelSuggestions` と違い「地図に出せる地域か」
 * では絞らない**——同一性の判定に要るのは解決の安定性だけで、表示可否は関係ない。
 * バッチ内の統合はこの関数の結果だけで一貫するので、突合側(解決済み `aopId` を使う)
 * と規則が違っても矛盾は生まれない。
 */
function itemAopId(item: WineListItem): string | undefined {
	const texts = [item.appellation, item.wineName].filter(
		(t): t is string => !!t,
	);
	return texts.length > 0 ? matchAop(texts)?.id : undefined;
}

/** 抽出結果からキーを作る(wineName がフォーム上の name に対応する)。 */
function itemIdentityKeys(item: WineListItem): WineIdentityKeys {
	return wineIdentityKeys({
		name: item.wineName,
		producer: item.producer,
		vintage: item.vintage,
		aopId: itemAopId(item),
	});
}

/**
 * 2段のキーで既出のものを引く。**strict を先に見る**(厳密一致のほうが取り違えが
 * 少ない)。見つからなければ loose で引く。
 */
function lookupByKeys<T>(
	keys: WineIdentityKeys,
	strictMap: Map<string, T>,
	looseMap: Map<string, T>,
): T | undefined {
	const strictHit = keys.strict ? strictMap.get(keys.strict) : undefined;
	if (strictHit) return strictHit;
	return keys.loose ? looseMap.get(keys.loose) : undefined;
}

/** 2段のキーを両方登録する(既に入っているキーは先勝ちで上書きしない)。 */
function registerKeys<T>(
	keys: WineIdentityKeys,
	value: T,
	strictMap: Map<string, T>,
	looseMap: Map<string, T>,
): void {
	if (keys.strict && !strictMap.has(keys.strict)) {
		strictMap.set(keys.strict, value);
	}
	if (keys.loose && !looseMap.has(keys.loose)) looseMap.set(keys.loose, value);
}

export interface DedupeResult {
	items: WineListItem[];
	/** 統合によって減った件数(= 重複として畳まれた件数)。サマリ表示に使う。 */
	mergedCount: number;
}

/**
 * バッチ内の重複を統合する(distinct の第1段)。**モデル側にも統合を指示している
 * が、その取りこぼしの保険**として同じ規則をアプリ側でも掛ける。写真をまたいだ
 * 同一銘柄は photo_indexes の和集合を持つ1件になる。
 *
 * スカラ項目は先に出てきた値を優先し、欠けているところだけ後続で埋める
 * (mergeExtractions と同じ流儀)。品種は和集合。
 */
export function dedupeWineListItems(items: WineListItem[]): DedupeResult {
	const byStrict = new Map<string, WineListItem>();
	const byLoose = new Map<string, WineListItem>();
	const out: WineListItem[] = [];
	for (const item of items) {
		const keys = itemIdentityKeys(item);
		const existing = lookupByKeys(keys, byStrict, byLoose);
		if (!existing) {
			const copy: WineListItem = {
				...item,
				grapeVarieties: [...item.grapeVarieties],
				photoIndexes: [...item.photoIndexes],
			};
			registerKeys(keys, copy, byStrict, byLoose);
			out.push(copy);
			continue;
		}
		existing.wineName ??= item.wineName;
		existing.producer ??= item.producer;
		existing.vintage ??= item.vintage;
		existing.appellation ??= item.appellation;
		existing.region ??= item.region;
		existing.country ??= item.country;
		existing.price ??= item.price;
		for (const g of item.grapeVarieties) {
			if (!existing.grapeVarieties.includes(g)) existing.grapeVarieties.push(g);
		}
		for (const i of item.photoIndexes) {
			if (!existing.photoIndexes.includes(i)) existing.photoIndexes.push(i);
		}
		existing.photoIndexes.sort((a, b) => a - b);
	}
	return { items: out, mergedCount: items.length - out.length };
}

/** 既存セラーとの突合に使う最小の形(DrunkWineEntry が構造的に適合する)。 */
export interface ExistingWineIdentity {
	id: string;
	name: string;
	producer?: string | null;
	vintage?: number | null;
	/** 保存済みの呼称ID。**loose キー(#435)の材料**で、無い行は strict だけで突き合わせる。 */
	aopId?: string | null;
	status: WineStatus;
}

/** レビュー画面に出す銘柄候補1件。 */
export interface WineListCandidate {
	/** フォームへ流し込める自動入力候補(エチケット解析と同じ形・同じ導出)。 */
	suggestions: LabelSuggestions;
	/** その店での売値(円)。目撃記録側に保存する。 */
	price?: number;
	/** この銘柄が写っていた写真の番号(0始まり)。 */
	photoIndexes: number[];
	/**
	 * 既存セラーの同一銘柄。**ある場合は新規作成せず、この銘柄に目撃記録を追加する**
	 * 候補として提示する(distinct の第2段)。
	 */
	existing?: {
		id: string;
		name: string;
		vintage: number | null;
		status: WineStatus;
	};
}

/**
 * 抽出結果を、マスタ突合済みのレビュー候補に変換する(銘柄ごとに
 * buildLabelSuggestions を再利用 = 呼称/地域/品種の解決規則を単体解析と共有する)。
 */
export function buildWineListCandidates(
	items: WineListItem[],
): WineListCandidate[] {
	return items.map((item) => ({
		suggestions: buildLabelSuggestions(item),
		price: item.price,
		photoIndexes: item.photoIndexes,
	}));
}

/**
 * 候補を既存セラーと突合し、一致したものに existing を付ける(distinct の第2段)。
 * キーは wineIdentityKeys で第1段(バッチ内の統合)と共有する。
 *
 * 比較対象は **buildLabelSuggestions 後の値**にする。名前が読めなかった銘柄は
 * 呼称の日本語名で補われるため、補完前の生の抽出値で突き合わせると「保存したら
 * 同名になるのに新規作成される」ズレが出る。
 *
 * 同じキーの既存エントリが複数ある場合は最初の1件を採る(entries は新しい順で
 * 渡ってくるため、直近に登録したものが選ばれる)。
 */
export function matchExistingEntries(
	candidates: WineListCandidate[],
	entries: readonly ExistingWineIdentity[],
): WineListCandidate[] {
	const byStrict = new Map<string, ExistingWineIdentity>();
	const byLoose = new Map<string, ExistingWineIdentity>();
	for (const entry of entries) {
		registerKeys(wineIdentityKeys(entry), entry, byStrict, byLoose);
	}
	return candidates.map((candidate) => {
		const keys = wineIdentityKeys({
			name: candidate.suggestions.name,
			producer: candidate.suggestions.producer,
			vintage: candidate.suggestions.vintage,
			aopId: candidate.suggestions.aopId,
		});
		const hit = lookupByKeys(keys, byStrict, byLoose);
		if (!hit) return candidate;
		return {
			...candidate,
			existing: {
				id: hit.id,
				name: hit.name,
				vintage: hit.vintage ?? null,
				status: hit.status,
			},
		};
	});
}

// 予約トークンの見積(estimateWineListReserveTokens)は config.ts に置いてある。
// 解析前に必要クレジットを出す UI から import するため、静的マスタを読み込む
// このファイルには置けない(理由は config.ts の同関数のコメント)。
