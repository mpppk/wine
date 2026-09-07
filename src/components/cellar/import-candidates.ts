import {
	buildCreateInput,
	buildTastingInput,
	type DrunkWineFieldsValue,
	EMPTY_TASTING_DRAFT,
	toFormState,
	type WineTastingDraft,
} from "#/components/cellar/drunk-wine-payload";
import type {
	PhotoKind,
	WineListCandidate,
} from "#/lib/ai/wine-list-extraction";
import type { WineStatus } from "#/lib/drunk-wine/status";
import type { BulkRegisterFromScanInput } from "#/lib/import-batch/schema";

// 一括登録のレビュー画面(/cellar/import の Step 2)の状態と送信ペイロードの変換。
// 画面本体は server fn 経由で cloudflare:workers に到達するため unit テストできない
// ので、変換だけを純関数として切り出す(drunk-wine-payload.ts と同じ方針)。
//
// **銘柄の入力仕様は DrunkWineFields / drunk-wine-payload の SSOT を再利用する**。
// カードごとにフォームを別実装すると、MCP App のフォームで起きた「photo_urls 対応
// 漏れ」(#185)と同じドリフトが、今度は一括登録の経路で再演する。

/** 見かけただけのワインの既定ステータス。一括登録の主要ケース(Issue #358)。 */
const IMPORT_DEFAULT_STATUS: WineStatus = "spotted";

/** レビュー画面のカード1件ぶんの状態。 */
export interface ImportCardState {
	/** React の key / 入力欄の id 接頭辞。候補の並び順から採番する */
	localId: string;
	/** 登録するか(既定 ON) */
	selected: boolean;
	/** 銘柄の入力値。DrunkWineFields がそのまま扱える形 */
	values: DrunkWineFieldsValue;
	/** 「飲んだ」トグル。ON なら飲用記録を同時に作る */
	drunk: boolean;
	tasting: WineTastingDraft;
	/** その店での売値(円)。銘柄ではなく目撃記録に保存する */
	sightingPrice: string;
	/**
	 * 参考サイトの一覧(IMPL-3)。解析結果の表示用で、フォームへは流し込まない。
	 * カードの展開部で共通コンポーネント(`ReferenceLinksList`)から出す。
	 */
	referenceLinks?: WineListCandidate["referenceLinks"];
	/** 複数ソースの価格一覧(IMPL-3)。同上(`PriceList` から出す)。 */
	prices?: WineListCandidate["prices"];
	/** この銘柄が写っていた写真の番号(0始まり・表示用) */
	photoIndexes: number[];
	/**
	 * 銘柄の写真に使う「適切な写真」の番号(#473)。バッチ写真のうち、その1本だけを
	 * 写しているもの。あればこれを目撃記録の写真番号にも使い、web からは取りに行かない。
	 */
	bottlePhotoIndex?: number;
	/** web から取り込む銘柄写真のURL(#473)。`bottlePhotoIndex` があるときは持たない。 */
	imageUrl?: string;
	/** 取り込む画像と実物のズレの説明(#473)。取り込めたときだけコメントへ追記される。 */
	imageNote?: string;
	/**
	 * 銘柄写真の由来(IMPL-4)。レビューカードが WEB の overlay を出すかの材料。
	 * 候補の `photoKind` を写すだけにする(ここで有無判定を書き直さない。
	 * 判定は `photoKindForPhotoHints` が唯一の入口)。
	 */
	photoKind: PhotoKind;
	/** 既存セラーの同一銘柄。ある場合は新規作成せず目撃記録だけを足す */
	existing?: WineListCandidate["existing"];
}

/**
 * 解析の自動入力候補をフォームの入力値へ変換する。
 *
 * 一括登録のレビューカードと、単一ワインと判定されたときの「ワインを記録」への
 * 引き継ぎ(#416)が共有する。**産地を「最も細かい1つだけ」へ畳む規則をここに
 * 一本化する**のが要点で、経路ごとに書くと片方だけ aopId と countryId を同時に
 * 持つフォーム状態を作ってしまう。
 *
 * @param status 既定のステータス。経路ごとに違う(一括=見かけた / 単体=フォームの既定)
 * @param price 銘柄の価格欄の初期値。未指定なら空
 */
export function valuesFromSuggestions(
	suggestions: WineListCandidate["suggestions"],
	status: WineStatus,
	price?: number,
): DrunkWineFieldsValue {
	return {
		name: suggestions.name ?? "",
		status,
		vintage: suggestions.vintage != null ? String(suggestions.vintage) : "",
		producer: suggestions.producer ?? "",
		price: price != null ? String(price) : "",
		aopId: suggestions.aopId,
		regionId: suggestions.aopId ? undefined : suggestions.regionId,
		countryId:
			suggestions.aopId || suggestions.regionId
				? undefined
				: suggestions.countryId,
		grapeVarietyIds: suggestions.grapeVarietyIds ?? [],
		// 解析が付けたコメント(#471)。一括登録では生産者の説明だけが載る
		note: suggestions.note ?? "",
	};
}

/**
 * 解析結果の候補をカードの初期状態にする。
 *
 * - ステータスの既定は「見かけた」。写真に写っているワインのほとんどは
 *   飲んでも所有もしていない、というのがこの機能の前提(Issue #358)
 * - 解析で読み取った価格は**目撃記録側**へ入れる。銘柄の price は「そのワインの
 *   値段」だが、リストに載っているのは「その店での売値」で、店ごとに違うため
 * - 既存一致のカードも編集可能な values を持つ。ユーザが名前やヴィンテージを
 *   直せば別の銘柄になるので、そのときは既存一致を外す(detachExisting)
 */
export function buildImportCards(
	candidates: WineListCandidate[],
): ImportCardState[] {
	return candidates.map((candidate, index) => ({
		localId: `c${index}`,
		selected: true,
		// 銘柄の価格は空のまま(price を渡さない)。リスト記載の価格は目撃記録側
		// (sightingPrice)へ入れる
		values: valuesFromSuggestions(candidate.suggestions, IMPORT_DEFAULT_STATUS),
		drunk: false,
		tasting: EMPTY_TASTING_DRAFT,
		sightingPrice: candidate.price != null ? String(candidate.price) : "",
		photoIndexes: candidate.photoIndexes,
		// 参考サイト・価格(IMPL-3)は表示用にそのまま持ち回る(フォームには流し込まない)。
		...(candidate.referenceLinks?.length
			? { referenceLinks: candidate.referenceLinks }
			: {}),
		...(candidate.prices?.length ? { prices: candidate.prices } : {}),
		// 写真の手当て(#473)は解析の判断をそのまま持ち回る。カード上で編集はさせない
		// (「どの写真がこの1本を写しているか」は写真を見ないと決められず、レビュー画面の
		// 目的=銘柄の内容の確認から外れる)。
		...(candidate.bottlePhotoIndex !== undefined
			? { bottlePhotoIndex: candidate.bottlePhotoIndex }
			: {}),
		...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
		...(candidate.imageNote ? { imageNote: candidate.imageNote } : {}),
		// 由来は候補の判定をそのまま写す(判定の入口は `photoKindForPhotoHints` の
		// 1箇所。ここで有無判定を書き直すと表示と登録で食い違う)。
		photoKind: candidate.photoKind,
		existing: candidate.existing,
	}));
}

/**
 * 既存一致を外す(新規作成に切り替える)。ユーザが銘柄の内容を編集したときに使う:
 * 「既存の『シャブリ 2020』に目撃を追加」と表示したまま名前を書き換えられると、
 * 画面の表示と実際に起きること(既存エントリは変更されない)が食い違う。
 */
export function detachExisting(card: ImportCardState): ImportCardState {
	return card.existing ? { ...card, existing: undefined } : card;
}

/** レビュー画面のサマリ。 */
export interface ImportSelectionSummary {
	/** 登録対象(チェックON)の件数 */
	selected: number;
	/** うち新規作成する銘柄 */
	create: number;
	/** うち既存エントリへ目撃記録を足すもの */
	attach: number;
	/** うち飲用記録も作るもの */
	drunk: number;
}

export function summarizeImportCards(
	cards: ImportCardState[],
): ImportSelectionSummary {
	const selected = cards.filter((c) => c.selected);
	return {
		selected: selected.length,
		create: selected.filter((c) => !c.existing).length,
		attach: selected.filter((c) => !!c.existing).length,
		drunk: selected.filter((c) => c.drunk).length,
	};
}

/**
 * 送信できない状態なら理由を返す(送信ボタンの無効化と説明に使う)。
 * サーバ側の zod でも弾かれるが、確定前に画面で気づけるほうが手戻りが少ない。
 */
export function validateImportCards(cards: ImportCardState[]): string | null {
	const selected = cards.filter((c) => c.selected);
	if (selected.length === 0) return "登録するワインを1つ以上選んでください";
	if (selected.some((c) => !c.existing && !c.values.name.trim())) {
		return "名前が空のワインがあります(チェックを外すか名前を入れてください)";
	}
	return null;
}

/** 数値入力(文字列)を整数に寄せる。空・数値化できない値は undefined。 */
function toIntOrUndefined(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) ? n : undefined;
}

export interface ImportBatchMeta {
	/** 既存の場所を選んだ場合のID */
	placeId?: string;
	/** その場で作る場所の名前(placeId と排他) */
	newPlaceName?: string;
	seenOn?: string;
	/** 後段でアップロードする写真の枚数 */
	photoCount: number;
}

/**
 * カード群とバッチ情報を server fn の入力へ変換する。チェックの外れたカードは
 * 落とす。銘柄の入力値は buildCreateInput(= フォームの送信規約の SSOT)を
 * 通してから飲用記録を外し、一括登録の item 形に合わせる。
 *
 * 写真番号は**先頭の1枚だけ**を目撃記録に持たせる。同じ銘柄が複数の写真に
 * 写っていても「その店で1回見かけた」であって複数回の目撃ではないため、
 * 写真ごとに目撃記録を作ると sightingCount(何回見かけたか)が写真の枚数に
 * 引きずられて意味を失う。
 */
export function buildBulkRegisterInput(
	cards: ImportCardState[],
	meta: ImportBatchMeta,
): BulkRegisterFromScanInput {
	const items = cards
		.filter((card) => card.selected)
		.map((card) => {
			const sightingPrice = toIntOrUndefined(card.sightingPrice);
			// 目撃記録に持たせる写真は「その1本だけを写した写真」を優先する(#473)。
			// この番号は**銘柄の写真の取得元にもなる**(saveImportBatchPhotos が
			// バッチ写真から複製する)ので、単体の写真があるならそちらを指しておく。
			const photoIndex = card.bottlePhotoIndex ?? card.photoIndexes[0];
			const sighting = {
				...(photoIndex != null ? { photoIndex } : {}),
				...(sightingPrice != null ? { price: sightingPrice } : {}),
			};
			const tasting = card.drunk ? buildTastingInput(card.tasting) : undefined;
			// 「飲んだ」トグルが ON なら、全項目が空でも飲用記録は作る(日付・評価を
			// 覚えていなくても「飲んだ」という事実は残す。markWineDrunk と同じ扱い)
			const tastingInput = card.drunk ? (tasting ?? {}) : undefined;
			const base = {
				...(Object.keys(sighting).length > 0 ? { sighting } : {}),
				...(tastingInput ? { tasting: tastingInput } : {}),
			};
			if (card.existing) {
				// 既存エントリには web 写真を送らない(#473)。そのエントリの写真は
				// ユーザのもので、目撃記録を足すだけの操作が差し替えてよいものではない。
				return { existingId: card.existing.id, ...base };
			}
			const { tasting: _unused, ...wine } = buildCreateInput(
				toFormState(card.values),
			);
			const webPhoto = card.imageUrl
				? {
						webPhoto: {
							url: card.imageUrl,
							...(card.imageNote ? { note: card.imageNote } : {}),
							// 由来は web 固定。webPhoto を送るのは web 画像を取りに
							// 行く銘柄だけで、サーバは webPhoto の有無で採用を決める
							// (card.photoKind と一致する。判定の入口は
							// `photoKindForPhotoHints` の1箇所)。
							photoKind: "web" as const,
						},
					}
				: {};
			return { wine, ...webPhoto, ...base };
		});
	return {
		...(meta.placeId ? { placeId: meta.placeId } : {}),
		...(meta.newPlaceName?.trim()
			? { newPlace: { name: meta.newPlaceName.trim() } }
			: {}),
		...(meta.seenOn ? { seenOn: meta.seenOn } : {}),
		photoCount: meta.photoCount,
		items,
	};
}
