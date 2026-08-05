import { describe, expect, it } from "vitest";
import {
	aopProgressState,
	buildKindFacets,
	groupTokens,
	PROGRESS_FILTER_STATES,
	PROGRESS_TOKENS,
	progressLabelJa,
	progressToken,
} from "./aop-filter";
import { AOP_KINDS } from "./map-style";
import { REGIONS } from "./regions";
import { listAops } from "./service";

describe("aopProgressState", () => {
	it("1問も正解していなければ未着手", () => {
		expect(aopProgressState({ solved: 0, total: 5 })).toBe("untouched");
	});

	it("一部だけ正解していれば学習中", () => {
		expect(aopProgressState({ solved: 2, total: 5 })).toBe("learning");
		// 分母に1問だけ残っていても学習中(全問正解の手前)
		expect(aopProgressState({ solved: 4, total: 5 })).toBe("learning");
	});

	it("全問正解していれば全問正解", () => {
		expect(aopProgressState({ solved: 5, total: 5 })).toBe("complete");
		expect(aopProgressState({ solved: 1, total: 1 })).toBe("complete");
	});

	it("solved が total を超えていても全問正解に落とす", () => {
		// 出題プールが縮んだ後の古い正解記録などで起こりうる
		expect(aopProgressState({ solved: 6, total: 5 })).toBe("complete");
	});

	it("進捗エントリが無いAOPは未着手", () => {
		// スコープに候補問題が1問も無いAOP。全問正解には決してならないので
		// 「まだ解いていない」側に寄せる
		expect(aopProgressState(undefined)).toBe("untouched");
		expect(aopProgressState({ solved: 0, total: 0 })).toBe("untouched");
	});
});

describe("進捗フィルタのトークン", () => {
	it("PROGRESS_TOKENS は状態と1対1で並び順も一致する", () => {
		expect(PROGRESS_TOKENS).toEqual(PROGRESS_FILTER_STATES.map(progressToken));
		expect(new Set(PROGRESS_TOKENS).size).toBe(PROGRESS_FILTER_STATES.length);
	});

	it("全状態に日本語ラベルがある", () => {
		for (const state of PROGRESS_FILTER_STATES) {
			expect(progressLabelJa(state)).not.toBe("");
		}
	});

	// 進捗トークンは区分・格付けと同じ `hide` パラメータに同居する。実データ由来の
	// 区分トークン(`village`)・区分:格付けトークン(`vineyard:grand-cru`)と衝突すると、
	// 片方をトグルしたつもりでもう片方まで消える。
	it("実データの区分・格付けトークンと衝突しない", () => {
		const progressTokens = new Set(PROGRESS_TOKENS);
		for (const region of REGIONS.filter((r) => r.enabled)) {
			const aops = listAops({ regionId: region.id });
			const presentKinds = AOP_KINDS.filter((k) =>
				aops.some((a) => a.kind === k),
			);
			for (const kf of buildKindFacets(aops, presentKinds)) {
				for (const token of groupTokens(kf)) {
					expect(progressTokens.has(token)).toBe(false);
				}
			}
		}
	});
});
