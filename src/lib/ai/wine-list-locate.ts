import {
	normalizePhotoBox,
	type PhotoBox,
	type PhotoBoxEntry,
} from "#/lib/drunk-wine/photo-box";
import {
	AI_WINE_LIST_LOCATE_MIN_CONFIDENCE,
	AI_WINE_LIST_LOCATE_MIN_PRESENCE,
	AI_WINE_LIST_LOCATE_MODEL,
	AI_WINE_LIST_LOCATE_WINES_PER_REQUEST,
} from "./config";
import type {
	OpenRouterDecisionQuestion,
	OpenRouterDecisionRequest,
} from "./openrouter";
import type { WineListCandidate } from "./wine-list-extraction";

// 一括抽出の銘柄が写真のどこにあったかを Jev の Box で求める(Issue #693)純ロジック。
// 問いの組み立てと答えの解釈を DB/env 非依存で切り出し、単体テスト可能にする
// (Jev の実行・写真の変換・計装は ai-service 側)。
//
// 1リクエスト = 写真1枚 + その写真に写っている銘柄の問い。銘柄1件につき
//  - Box(`b<n>`): その銘柄の位置
//  - Noul(`p<n>`): その銘柄が写っている確率
// の2問を並べる。Box は対象が無くても4辺を返すので、Noul が低い・confidence が
// 低い枠は採らない(枠なしで複製する。解析・登録は止めない)。

/**
 * 指示文の銘柄名の差し込み位置(#693)。指示文は Langfuse 管理下にあり、銘柄ごとに
 * `getManagedPrompt` を呼ぶと1回の解析で最大 80銘柄 × 2問ぶん取得が走る
 * (失敗はキャッシュされないので、Langfuse 障害時は毎回タイムアウトを払う)。
 * そこで**この値を変数として1回だけ差し込んで取得し、銘柄ごとに置き換える**。
 * 英数字だけで組むのは mustache のエスケープ・プレースホルダ検査に掛からないため。
 */
export const LOCATE_WINE_SLOT = "WINELOCATESLOT7F3A";

/** 解決済みの指示文(`LOCATE_WINE_SLOT` を含む)。 */
export interface LocateInstructions {
	box: string;
	presence: string;
}

/** 指示文の銘柄名を差し込む。 */
export function fillLocateInstruction(template: string, wine: string): string {
	return template.split(LOCATE_WINE_SLOT).join(wine);
}

/**
 * 指示文に入れる銘柄の表示名。生産者・ワイン名・ヴィンテージを空白で連ねる
 * (リストの行は「生産者 キュヴェ 年」の並びが多く、そのまま照合の手掛かりになる)。
 * 名前も生産者も無い候補は null(問いを立てない)。
 */
export function locateWineLabel(
	suggestions: WineListCandidate["suggestions"],
): string | null {
	const name = suggestions.name?.trim();
	const producer = suggestions.producer?.trim();
	if (!name && !producer) return null;
	const parts: string[] = [];
	if (producer) parts.push(producer);
	// 名前が生産者名をそのまま含む(シャトー名=ワイン名)ときは重ねない。
	if (name && !(producer && name.includes(producer))) parts.push(name);
	if (suggestions.vintage != null) parts.push(String(suggestions.vintage));
	// 指示文の引用符を壊さない。
	return parts.join(" ").replace(/"/g, "'");
}

/** 写真1枚ぶんの問い合わせ。 */
export interface LocateRequestPlan {
	photoIndex: number;
	/** この写真に写っている候補の番号(`candidates` の index)と表示名 */
	targets: { candidateIndex: number; label: string }[];
}

/**
 * 候補群から、写真ごとの問い合わせを組み立てる。**対応のある全写真が対象**
 * (`photoIndexes` と、その1本だけを写した `bottlePhotoIndex` の和集合)。
 * 1枚の写真に載せる銘柄は `AI_WINE_LIST_LOCATE_WINES_PER_REQUEST` で割る。
 */
export function planLocateRequests(
	candidates: readonly Pick<
		WineListCandidate,
		"suggestions" | "photoIndexes" | "bottlePhotoIndex"
	>[],
	photoCount: number,
): LocateRequestPlan[] {
	const byPhoto = new Map<number, LocateRequestPlan["targets"]>();
	candidates.forEach((candidate, candidateIndex) => {
		const label = locateWineLabel(candidate.suggestions);
		if (!label) return;
		const indexes = new Set(candidate.photoIndexes);
		if (candidate.bottlePhotoIndex !== undefined) {
			indexes.add(candidate.bottlePhotoIndex);
		}
		for (const photoIndex of indexes) {
			if (photoIndex < 0 || photoIndex >= photoCount) continue;
			const list = byPhoto.get(photoIndex) ?? [];
			list.push({ candidateIndex, label });
			byPhoto.set(photoIndex, list);
		}
	});
	const plans: LocateRequestPlan[] = [];
	for (const photoIndex of [...byPhoto.keys()].sort((a, b) => a - b)) {
		const targets = byPhoto.get(photoIndex) ?? [];
		for (
			let i = 0;
			i < targets.length;
			i += AI_WINE_LIST_LOCATE_WINES_PER_REQUEST
		) {
			plans.push({
				photoIndex,
				targets: targets.slice(i, i + AI_WINE_LIST_LOCATE_WINES_PER_REQUEST),
			});
		}
	}
	return plans;
}

const boxKey = (i: number) => `b${i}`;
const presenceKey = (i: number) => `p${i}`;

/** 問い合わせ1件を decisions のリクエストにする。`imageDataUrl` は PNG / JPEG。 */
export function buildLocateRequest(
	plan: LocateRequestPlan,
	imageDataUrl: string,
	instructions: LocateInstructions,
): OpenRouterDecisionRequest {
	const questions: Record<string, OpenRouterDecisionQuestion> = {};
	plan.targets.forEach((target, i) => {
		questions[boxKey(i)] = {
			type: "box",
			instructions: fillLocateInstruction(instructions.box, target.label),
		};
		questions[presenceKey(i)] = {
			type: "noul",
			instructions: fillLocateInstruction(instructions.presence, target.label),
		};
	});
	return {
		model: AI_WINE_LIST_LOCATE_MODEL,
		state: [
			"A photo of a restaurant wine list, a wine shop shelf or display, or wine bottles.",
			{ type: "image_url", image_url: { url: imageDataUrl } },
		],
		questions,
	};
}

/** 1銘柄ぶんの答え。採否の理由は観測(Langfuse の output)に残す。 */
export interface LocateAnswer {
	candidateIndex: number;
	box: PhotoBox | null;
	presence: number | null;
	confidence: number | null;
}

function asProbability(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(1, Math.max(0, value))
		: null;
}

/**
 * decisions の答えを銘柄ごとの枠にする。**決して throw しない**(形が違う答えは
 * その銘柄の枠なしとして扱う)。
 *
 * 採るのは `presence >= MIN_PRESENCE` かつ `confidence >= MIN_CONFIDENCE` の枠だけ。
 * どちらかが欠けた答えも採らない(早期機能で形式が変わりうるため、読めない答えを
 * 「写っている」に倒さない)。
 */
export function parseLocateAnswers(
	plan: LocateRequestPlan,
	answers: Record<string, unknown>,
): LocateAnswer[] {
	return plan.targets.map((target, i) => {
		const boxAnswer = answers[boxKey(i)];
		const presenceAnswer = answers[presenceKey(i)];
		const boxRecord =
			boxAnswer && typeof boxAnswer === "object"
				? (boxAnswer as Record<string, unknown>)
				: {};
		const presenceRecord =
			presenceAnswer && typeof presenceAnswer === "object"
				? (presenceAnswer as Record<string, unknown>)
				: {};
		const presence = asProbability(presenceRecord.noul);
		const confidence = asProbability(boxRecord.confidence);
		const box = normalizePhotoBox(boxRecord.box);
		const accepted =
			box !== null &&
			presence !== null &&
			presence >= AI_WINE_LIST_LOCATE_MIN_PRESENCE &&
			confidence !== null &&
			confidence >= AI_WINE_LIST_LOCATE_MIN_CONFIDENCE;
		return {
			candidateIndex: target.candidateIndex,
			box: accepted ? box : null,
			presence,
			confidence,
		};
	});
}

/**
 * 写真ごとの答えを候補へ載せる(`photoBoxes`)。枠が1つも無い候補は
 * `photoBoxes` を持たない(結果の JSON を膨らませない)。
 */
export function attachPhotoBoxes<T extends object>(
	candidates: readonly T[],
	results: readonly { photoIndex: number; answers: readonly LocateAnswer[] }[],
): (T & { photoBoxes?: PhotoBoxEntry[] })[] {
	const byCandidate = new Map<number, PhotoBoxEntry[]>();
	for (const result of results) {
		for (const answer of result.answers) {
			if (!answer.box) continue;
			const list = byCandidate.get(answer.candidateIndex) ?? [];
			if (list.some((entry) => entry.photoIndex === result.photoIndex)) {
				continue;
			}
			list.push({ photoIndex: result.photoIndex, box: answer.box });
			byCandidate.set(answer.candidateIndex, list);
		}
	}
	return candidates.map((candidate, index) => {
		const boxes = byCandidate.get(index);
		if (!boxes?.length) return candidate;
		return {
			...candidate,
			photoBoxes: [...boxes].sort((a, b) => a.photoIndex - b.photoIndex),
		};
	});
}
