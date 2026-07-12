import type { Aop, Region } from "./types";

// AOPの説明文(プレーンテキスト)中に現れる「他の村・畑(AOP)名」「地域名」を検出し、
// リンク可能なセグメントへ分割するピュアユーティリティ。データ側にリンク注記を
// 持たせず、キュレーション済みの名称辞書との最長一致で自動リンク化する。
// UI(AopDetailPanel)から呼ばれるが、描画とは独立させてテスト可能にしている。

export type DescriptionSegment =
	| { kind: "text"; text: string }
	| { kind: "aop"; text: string; aopId: string }
	| { kind: "region"; text: string; regionId: string };

type LinkTarget =
	| { kind: "aop"; aopId: string }
	| { kind: "region"; regionId: string };

interface BuildOptions {
	/** リンク元のAOP。自己名・自地域名はリンク対象から除外する */
	currentAop: Aop;
	/** リンク候補となる同地域のAOP群(currentAop を含んでいてよい) */
	aops: readonly Aop[];
	/** リンク候補となる地域群(enabled のみが対象。currentAop の地域は除外される) */
	regions: readonly Region[];
}

/**
 * 説明文を、プレーンテキストとリンク(AOP/地域)のセグメント列に分割する。
 *
 * 一致は「最長一致・非重複・左優先」。候補名を長さ降順で並べ、文字列を左から走査して
 * 位置ごとに最長の候補名を当てる。これにより「コート・ド・ブルイィ」を「ブルイィ」より
 * 優先し、内側の短い名前を二重リンクしない。日本語は語境界が無いため部分一致で稀に
 * 誤リンクし得るが、自己名除外・曖昧名の先勝ちで軽減する。
 */
export function buildDescriptionSegments(
	description: string,
	{ currentAop, aops, regions }: BuildOptions,
): DescriptionSegment[] {
	const byName = buildNameIndex(currentAop, aops, regions);
	// 長い名前から試すことで最長一致を保証する
	const names = Array.from(byName.keys()).sort((a, b) => b.length - a.length);

	const segments: DescriptionSegment[] = [];
	let pending = ""; // 直近のテキスト run(リンクに挟まれた素のテキスト)

	const flushPending = () => {
		if (pending) {
			segments.push({ kind: "text", text: pending });
			pending = "";
		}
	};

	let i = 0;
	while (i < description.length) {
		const name = names.find((n) => description.startsWith(n, i));
		if (name) {
			flushPending();
			const target = byName.get(name);
			// byName に載っている以上 target は必ず存在するが、型の都合で分岐する
			if (target?.kind === "aop") {
				segments.push({ kind: "aop", text: name, aopId: target.aopId });
			} else if (target?.kind === "region") {
				segments.push({
					kind: "region",
					text: name,
					regionId: target.regionId,
				});
			}
			i += name.length;
		} else {
			pending += description[i];
			i += 1;
		}
	}
	flushPending();
	return segments;
}

// 名称 -> リンク先の索引を作る。名称の重複(異なる実体が同名)は先勝ちで、後続を捨てる
// (曖昧な名前で誤ったリンクを張らないため)。空名は登録しない。
function buildNameIndex(
	currentAop: Aop,
	aops: readonly Aop[],
	regions: readonly Region[],
): Map<string, LinkTarget> {
	const byName = new Map<string, LinkTarget>();
	const add = (name: string, target: LinkTarget) => {
		if (name && !byName.has(name)) byName.set(name, target);
	};

	// 同地域の他AOP: nameJa と(異なれば)shortName の両方を候補にする
	for (const aop of aops) {
		if (aop.id === currentAop.id) continue;
		const target: LinkTarget = { kind: "aop", aopId: aop.id };
		add(aop.nameJa, target);
		if (aop.shortName !== aop.nameJa) add(aop.shortName, target);
	}

	// 地域名: enabled かつ自地域以外(自地域名のリンクは無意味なため除外)
	for (const region of regions) {
		if (!region.enabled || region.id === currentAop.region) continue;
		add(region.nameJa, { kind: "region", regionId: region.id });
	}

	return byName;
}
