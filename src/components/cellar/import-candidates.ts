import {
	buildCreateInput,
	buildTastingInput,
	type DrunkWineFieldsValue,
	EMPTY_TASTING_DRAFT,
	toFormState,
	type WineTastingDraft,
} from "#/components/cellar/drunk-wine-payload";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
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
export const IMPORT_DEFAULT_STATUS: WineStatus = "spotted";

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
	/** この銘柄が写っていた写真の番号(0始まり・表示用) */
	photoIndexes: number[];
	/** 既存セラーの同一銘柄。ある場合は新規作成せず目撃記録だけを足す */
	existing?: WineListCandidate["existing"];
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
		values: {
			name: candidate.suggestions.name ?? "",
			status: IMPORT_DEFAULT_STATUS,
			vintage:
				candidate.suggestions.vintage != null
					? String(candidate.suggestions.vintage)
					: "",
			producer: candidate.suggestions.producer ?? "",
			// 銘柄の価格は空のまま。リスト記載の価格は目撃記録側(sightingPrice)へ
			price: "",
			aopId: candidate.suggestions.aopId,
			regionId: candidate.suggestions.regionId,
			grapeVarietyIds: candidate.suggestions.grapeVarietyIds ?? [],
		},
		drunk: false,
		tasting: EMPTY_TASTING_DRAFT,
		sightingPrice: candidate.price != null ? String(candidate.price) : "",
		photoIndexes: candidate.photoIndexes,
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
			const photoIndex = card.photoIndexes[0];
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
				return { existingId: card.existing.id, ...base };
			}
			const { tasting: _unused, ...wine } = buildCreateInput(
				toFormState(card.values),
			);
			return { wine, ...base };
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
