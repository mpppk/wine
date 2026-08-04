import { beforeEach, describe, expect, it } from "vitest";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import { DEFAULT_WINE_STATUS } from "#/lib/drunk-wine/status";
import type { WineListAnalysisSummary } from "#/lib/services/ai-service";
import {
	buildSingleWineHandoff,
	MAX_HANDOFF_PHOTOS,
	setSingleWineHandoff,
	singleWineCandidate,
	takeSingleWineHandoff,
} from "./single-wine-handoff";

function candidate(
	partial: Partial<WineListCandidate> = {},
): WineListCandidate {
	return {
		suggestions: { name: "Chablis Les Clos" },
		photoIndexes: [0],
		...partial,
	};
}

function summary(
	partial: Partial<WineListAnalysisSummary> = {},
): WineListAnalysisSummary {
	return {
		detected: 1,
		subject: "single_wine",
		mergedDuplicates: 0,
		matchedExisting: 0,
		truncated: false,
		...partial,
	};
}

function photoFile(name: string): File {
	return new File(["x"], name, { type: "image/jpeg" });
}

describe("singleWineCandidate", () => {
	it("単一ワイン判定 かつ 1銘柄なら候補を返す", () => {
		const c = candidate();
		expect(singleWineCandidate([c], summary())).toBe(c);
	});

	it("リスト・棚と判定されたら候補にしない", () => {
		expect(
			singleWineCandidate([candidate()], summary({ subject: "wine_list" })),
		).toBeNull();
	});

	it("単一ワイン判定でも複数銘柄が読めていたら候補にしない", () => {
		// 「1本のつもりで撮った棚の写真」から他の銘柄が黙って落ちるのを防ぐ
		const candidates = [
			candidate({ suggestions: { name: "Chablis" } }),
			candidate({ suggestions: { name: "Sancerre" } }),
		];
		expect(
			singleWineCandidate(candidates, summary({ detected: 2 })),
		).toBeNull();
	});

	it("銘柄を1件も読み取れなかったら候補にしない", () => {
		expect(singleWineCandidate([], summary({ detected: 0 }))).toBeNull();
	});

	it("既存セラーと一致していても候補にはする(遷移するかはユーザが選ぶ)", () => {
		const c = candidate({
			existing: {
				id: "e1",
				name: "Chablis Les Clos",
				vintage: 2020,
				status: "finished",
			},
		});
		expect(singleWineCandidate([c], summary({ matchedExisting: 1 }))).toBe(c);
	});
});

describe("buildSingleWineHandoff", () => {
	it("読み取った内容をフォームの初期値に変換する(ステータスはフォームの既定)", () => {
		const handoff = buildSingleWineHandoff(
			candidate({
				suggestions: {
					name: "Chablis Les Clos",
					producer: "Domaine Testut",
					vintage: 2020,
					aopId: "chablis-grand-cru",
					regionId: "bourgogne",
					countryId: "france",
					grapeVarietyIds: ["chardonnay"],
				},
			}),
			[],
		);
		expect(handoff.values).toMatchObject({
			name: "Chablis Les Clos",
			producer: "Domaine Testut",
			vintage: "2020",
			// 一括登録の既定「見かけた」は引き継がない
			status: DEFAULT_WINE_STATUS,
			grapeVarietyIds: ["chardonnay"],
		});
	});

	it("産地は最も細かい1つだけにする(AOPが取れたら地域・国は落とす)", () => {
		const { values } = buildSingleWineHandoff(
			candidate({
				suggestions: {
					aopId: "chablis-grand-cru",
					regionId: "bourgogne",
					countryId: "france",
				},
			}),
			[],
		);
		expect(values.aopId).toBe("chablis-grand-cru");
		expect(values.regionId).toBeUndefined();
		expect(values.countryId).toBeUndefined();
	});

	it("読み取れた価格は銘柄の価格欄に入れる", () => {
		const { values } = buildSingleWineHandoff(candidate({ price: 12000 }), []);
		expect(values.price).toBe("12000");
	});

	it("価格が読めなければ空のまま", () => {
		const { values } = buildSingleWineHandoff(candidate(), []);
		expect(values.price).toBe("");
	});

	it("写真は先頭 MAX_HANDOFF_PHOTOS 枚だけ引き継ぎ、落とした枚数を伝える", () => {
		const files = Array.from({ length: MAX_HANDOFF_PHOTOS + 2 }, (_, i) =>
			photoFile(`p${i}.jpg`),
		);
		const handoff = buildSingleWineHandoff(candidate(), files);
		expect(handoff.files).toHaveLength(MAX_HANDOFF_PHOTOS);
		expect(handoff.files[0]?.name).toBe("p0.jpg");
		expect(handoff.droppedPhotoCount).toBe(2);
	});

	it("上限以下なら全部引き継ぐ", () => {
		const handoff = buildSingleWineHandoff(candidate(), [photoFile("p0.jpg")]);
		expect(handoff.files).toHaveLength(1);
		expect(handoff.droppedPhotoCount).toBe(0);
	});
});

describe("荷物の受け渡し", () => {
	beforeEach(() => {
		takeSingleWineHandoff();
	});

	it("預けた荷物を1回だけ取り出せる", () => {
		const handoff = buildSingleWineHandoff(candidate(), [photoFile("p0.jpg")]);
		setSingleWineHandoff(handoff);
		expect(takeSingleWineHandoff()).toBe(handoff);
		// 2回目は空。保存後に「ワインを記録」を開き直しても前回の内容は蘇らない
		expect(takeSingleWineHandoff()).toBeNull();
	});

	it("預けていなければ null(通常の新規作成)", () => {
		expect(takeSingleWineHandoff()).toBeNull();
	});
});
