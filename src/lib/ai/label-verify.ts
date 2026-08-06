import { aopAllowsGrape, getAop } from "#/lib/wine/service";
import {
	type LabelExtraction,
	type LabelFieldSources,
	matchAop,
	matchGrapeVarietyIds,
} from "./label-extraction";
import type { WebResearchTrace } from "./web-research-trace";

// エージェントループの**停止条件**。モデルが `submit_answer` で出した答えをこちらで
// 検証し、通らなければ理由を返して考え直させる。
//
// **「確信あり」の自己申告では止めない**のが要点。#455 の実測では、同じ写真で4回とも
// 別の生産者を返し、そのすべてが `origin: "photo_and_web"` と参照URLを添えていた。
// 誤答が裏取り済みの体裁で出てくる以上、モデルの自己申告は停止条件に使えない。
//
// 一方で**検証器が過剰に厳しいと機能が壊れる**。AOPマスタは対応地域ぶんしか無く
// (516件)、未収録の産地のワインは正しく読めても呼称が引けない。そこで
// 「マスタに無い = 不合格」にはせず、**マスタの中で矛盾しているものだけ**を落とす。
// 判定は「間違っていると断定できるか」で書き、「確認できない」は通す。

/** 検証で見つかった問題。モデルへそのまま返して次のターンの手がかりにする。 */
export interface LabelProblem {
	/** 問題のあるフィールド。 */
	field: string;
	/** モデルに返す説明(日本語)。何をすれば直るかまで書く。 */
	message: string;
}

export interface LabelVerifyResult {
	ok: boolean;
	problems: LabelProblem[];
}

/** 検証に渡す文脈。web検索の軌跡は引用の裏取りに使う。 */
export interface LabelVerifyContext {
	/** モデルが自己申告したフィールドごとの根拠。 */
	fieldSources?: LabelFieldSources;
	/** 実際に検索・閲覧した軌跡。引用URLがこの中に出ているかを照合する。 */
	trace?: WebResearchTrace;
}

/** フォームと同じヴィンテージの許容範囲。 */
const VINTAGE_MIN = 1800;
const VINTAGE_MAX = 2100;

/** URL文字列からホスト名を取り出す。解釈できなければ undefined。 */
function toHost(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/**
 * 軌跡に現れたホスト名の集合。**ホスト単位で照合する**のは、検索結果のスニペットから
 * 同一サイトの別ページを引用することが正当にありうるため(URL完全一致だと誤検知する)。
 */
function tracedHosts(trace: WebResearchTrace | undefined): Set<string> {
	const hosts = new Set(trace?.hosts ?? []);
	for (const step of trace?.steps ?? []) {
		for (const url of step.urls ?? []) {
			const host = toHost(url);
			if (host) hosts.add(host);
		}
	}
	return hosts;
}

/**
 * 抽出結果とその根拠を検証する。**間違っていると断定できるものだけ**を問題として返す。
 *
 * 検査するのは3種類:
 *
 * 1. **ヴィンテージの範囲** — フォームが受け付けない値は候補として無意味。
 * 2. **呼称と品種の整合** — 呼称がマスタに解決でき、かつ品種もマスタに解決できたとき、
 *    その品種がその呼称で認められているか(`aopAllowsGrape`)。どちらかがマスタ外なら
 *    判定しない(未収録の産地・品種を不合格にしない)。
 * 3. **引用の裏取り** — `origin` が web を含むフィールドは、実際に検索・閲覧した
 *    ホストのURLを引いているか。**検索していないのに web を名乗る**、
 *    **見ていないサイトを引用する**を捕まえる。#455 で観測した「誤答＋それらしいURL」に
 *    直接効く検査で、モデルの内省では代替できない(こちらしか軌跡を持っていない)。
 */
export function verifyLabelAnswer(
	extraction: LabelExtraction,
	context: LabelVerifyContext = {},
): LabelVerifyResult {
	const problems: LabelProblem[] = [];

	if (
		extraction.vintage != null &&
		(extraction.vintage < VINTAGE_MIN || extraction.vintage > VINTAGE_MAX)
	) {
		problems.push({
			field: "vintage",
			message: `ヴィンテージ ${extraction.vintage} は西暦として不正です。${VINTAGE_MIN}〜${VINTAGE_MAX} の範囲で、写真から読み取れない場合は null にしてください。`,
		});
	}

	// 呼称 → マスタのAOP。解決できないのは未収録の産地でも起きるので、それ自体は問題にしない。
	const aopTexts = [extraction.appellation, extraction.wineName].filter(
		(t): t is string => !!t,
	);
	const aop = matchAop(aopTexts);
	if (aop) {
		// 品種名 → マスタのid。解決できなかった品種は判定対象外(マスタ未収録の可能性)。
		for (const rawName of extraction.grapeVarieties) {
			const ids = matchGrapeVarietyIds([rawName]);
			const varietyId = ids[0];
			if (!varietyId) continue;
			if (aopAllowsGrape(aop, varietyId)) continue;
			problems.push({
				field: "grape_varieties",
				message: `${aop.name} では ${rawName} は認められていません。呼称と品種のどちらかが誤っています。get_appellation で ${aop.id} の許可品種を確認し、両方を見直してください。`,
			});
		}
	}

	// 引用の裏取り。根拠を書いていないこと自体は問題にしない(Claude経路では書かれない
	// ことがある)。web を名乗ったときだけ、その裏付けを求める。
	const hosts = tracedHosts(context.trace);
	for (const [field, source] of Object.entries(context.fieldSources ?? {})) {
		if (!source || !source.origin.includes("web")) continue;
		if (!source.url) {
			problems.push({
				field,
				message: `${field} の根拠を "${source.origin}" としていますが参照URLがありません。実際に参照したページのURLを書くか、origin を "photo" / "unknown" に直してください。`,
			});
			continue;
		}
		const host = toHost(source.url);
		if (!host) {
			problems.push({
				field,
				message: `${field} の参照URL "${source.url}" はURLとして解釈できません。実際に参照したページのURLを書いてください。`,
			});
			continue;
		}
		if (hosts.size === 0) {
			problems.push({
				field,
				message: `${field} の根拠を "${source.origin}" としていますが、web検索を実行していません。web_search で裏を取るか、origin を "photo" / "unknown" に直してください。`,
			});
			continue;
		}
		if (!hosts.has(host)) {
			problems.push({
				field,
				message: `${field} の参照URL "${source.url}" は今回の検索で開いていないサイトです。実際に参照したページのURLだけを書いてください(URLを創作しない)。`,
			});
		}
	}

	return { ok: problems.length === 0, problems };
}

/**
 * 呼称が解決できたかどうか(自動入力の質の目安)。**検証には使わない**——マスタ未収録の
 * 産地で false になるのは正常なため。実行記録に載せて「どのくらいの割合でマスタに
 * 着地しているか」を観測するために使う。
 */
export function resolvesToKnownAop(extraction: LabelExtraction): boolean {
	const aop = matchAop(
		[extraction.appellation, extraction.wineName].filter(
			(t): t is string => !!t,
		),
	);
	return !!aop && !!getAop(aop.id);
}
