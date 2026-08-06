import { getProducerInfo } from "#/lib/wine/producer-info";
import {
	GRAPE_VARIETIES,
	getAop,
	getRegion,
	listAops,
} from "#/lib/wine/service";
import { AOP_TAG_LABELS_JA } from "#/lib/wine/tags";
import { normalizeLabelText } from "#/lib/wine/text-normalize";
import type { Aop } from "#/lib/wine/types";

// エチケット解析のエージェントループがモデルへ露出するツールの**中身**(純ロジック)。
// DB/env/SDK 非依存にして単体テスト可能にする(ツール定義そのものは label-tools.ts)。
//
// **なぜツールにするのか**: 従来はAOPの全名称(516件・約4,900トークン)を指示文へ丸ごと
// 同梱していた。1リクエストで完結する間はそれでよかったが、ループでは**毎ターン入力を
// 再送する**ので、固定費がターン数倍で効いてくる。検索ツールに置き換えると、必要な
// 数件だけを必要なときに渡せる。
//
// 副次的に、従来は表現できなかったことができるようになる:
//  - **惜しい候補を見せられる**。`matchAop` は当たるか当たらないかしか返さないので、
//    綴りが1文字違うと「該当なし」になって手がかりが消えていた
//  - **生産者名から呼称を逆引きできる**。ラベルの呼称が読めない/写っていないボトルでも、
//    生産者が分かれば産地に辿り着ける(#455 で観測した「…cougne しか読めない」ケース)

/** 検索が返す呼称の要約。1件あたりを短く保ち、複数件返しても入力を膨らませない。 */
export interface AppellationHit {
	id: string;
	/** INAO表記の正式名称。モデルにはこの綴りを使わせる。 */
	name: string;
	nameJa: string;
	/** 地域の日本語名(未対応地域なら undefined)。 */
	regionJa?: string;
	/** 格付けタグの日本語ラベル(特級・一級など)。 */
	classifications: string[];
}

/** 呼称の詳細。裏取りの突き合わせに使う材料を返す。 */
export interface AppellationDetail extends AppellationHit {
	country?: string;
	/** 主要品種(role=principal)の現地語名。 */
	principalGrapes: string[];
	/** 補助品種を含む全許可品種の現地語名。 */
	allowedGrapes: string[];
	/** この呼称に登録されている生産者名(先頭から上限まで)。 */
	producers: string[];
	soil?: string;
}

/** 生産者の逆引き結果。 */
export interface ProducerHit {
	name: string;
	/** この生産者が登録されている呼称(id と正式名)。 */
	appellations: { id: string; name: string; nameJa: string }[];
	/** 公式サイト(一次情報)。裏取りの検索先として渡す。 */
	officialWebsite?: string;
	description?: string;
}

/** 1回の検索で返す最大件数。多すぎると入力が膨らみ、少なすぎると正解を取りこぼす。 */
export const APPELLATION_SEARCH_LIMIT = 8;

/** 詳細で返す生産者名の上限(有名呼称は数十件登録されている)。 */
export const APPELLATION_DETAIL_PRODUCER_LIMIT = 20;

/** 生産者の逆引きで返す呼称数の上限。 */
export const PRODUCER_APPELLATION_LIMIT = 10;

/** 呼称1件を検索結果の形へ畳む。 */
function toHit(aop: Aop): AppellationHit {
	const region = getRegion(aop.region);
	return {
		id: aop.id,
		name: aop.name,
		nameJa: aop.nameJa,
		...(region ? { regionJa: region.nameJa } : {}),
		classifications: (aop.tags ?? [])
			.map((t) => AOP_TAG_LABELS_JA[t])
			.filter((l): l is string => !!l),
	};
}

/**
 * 呼称をあいまい検索する。**完全一致 → 前方一致 → 部分一致**の順で並べ、
 * 同じ強さなら名前の短い順(= より総称的なもの)にする。
 *
 * `matchAop`(抽出結果をマスタへ解決する本番の照合)と**別物**である点に注意:
 * あちらは誤爆を避けるため単語境界つきの厳格な一致だけを認める。こちらはモデルに
 * 候補を見せるための探索なので、緩く拾って判断はモデルに委ねる。
 */
export function searchAppellations(
	query: string,
	limit = APPELLATION_SEARCH_LIMIT,
): AppellationHit[] {
	const needle = normalizeLabelText(query);
	if (!needle) return [];
	const scored: { aop: Aop; score: number; length: number }[] = [];
	for (const aop of listAops()) {
		let best = 0;
		for (const label of [aop.name, aop.shortName, aop.nameJa]) {
			const hay = normalizeLabelText(label);
			if (!hay) continue;
			const score =
				hay === needle
					? 3
					: hay.startsWith(needle) || needle.startsWith(hay)
						? 2
						: hay.includes(needle) || needle.includes(hay)
							? 1
							: 0;
			if (score > best) best = score;
		}
		if (best > 0) {
			scored.push({ aop, score: best, length: aop.name.length });
		}
	}
	scored.sort((a, b) => b.score - a.score || a.length - b.length);
	return scored.slice(0, limit).map((s) => toHit(s.aop));
}

/** 品種IDを現地語名へ。マスタに無いIDはそのまま返す(黙って落とさない)。 */
function grapeLabel(varietyId: string): string {
	return (
		GRAPE_VARIETIES.find((v) => v.id === varietyId)?.nameLocal ?? varietyId
	);
}

/** 呼称の詳細を引く。未知のidなら undefined。 */
export function getAppellationDetail(
	id: string,
): AppellationDetail | undefined {
	const aop = getAop(id);
	if (!aop) return undefined;
	const region = getRegion(aop.region);
	return {
		...toHit(aop),
		...(region ? { country: region.countryJa } : {}),
		principalGrapes: aop.grapes
			.filter((g) => g.role === "principal")
			.map((g) => grapeLabel(g.varietyId)),
		allowedGrapes: aop.grapes.map((g) => grapeLabel(g.varietyId)),
		producers: aop.producers
			.slice(0, APPELLATION_DETAIL_PRODUCER_LIMIT)
			.map((p) => p.name),
		...(aop.soil ? { soil: aop.soil } : {}),
	};
}

/**
 * 生産者名から、その生産者が登録されている呼称を逆引きする。
 *
 * **ラベルの呼称が読めないボトルの主要な手がかり**。生産者名は大きく印字されている
 * ことが多く、呼称は瓶の曲面や汚れで欠けやすい(#455 の実測で観測した形)。
 *
 * 表記揺れに耐えるため正規化した部分一致で拾う("Chateau Recougne" ↔ "Château Recougne")。
 */
export function lookupProducer(name: string): ProducerHit[] {
	const needle = normalizeLabelText(name);
	if (!needle) return [];
	const byName = new Map<string, ProducerHit>();
	for (const aop of listAops()) {
		for (const producer of aop.producers) {
			const hay = normalizeLabelText(producer.name);
			if (!hay.includes(needle) && !needle.includes(hay)) continue;
			let hit = byName.get(producer.name);
			if (!hit) {
				const info = getProducerInfo(producer.name);
				hit = {
					name: producer.name,
					appellations: [],
					...(info?.officialWebsite
						? { officialWebsite: info.officialWebsite }
						: {}),
					...(info?.description ? { description: info.description } : {}),
				};
				byName.set(producer.name, hit);
			}
			if (hit.appellations.length < PRODUCER_APPELLATION_LIMIT) {
				hit.appellations.push({
					id: aop.id,
					name: aop.name,
					nameJa: aop.nameJa,
				});
			}
		}
	}
	return [...byName.values()];
}
