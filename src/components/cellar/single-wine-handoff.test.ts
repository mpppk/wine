import { describe, expect, it } from "vitest";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import { DEFAULT_WINE_STATUS } from "#/lib/drunk-wine/status";
import type { WineListAnalysisSummary } from "#/lib/services/ai-service";
import type { WineSightingDraft } from "./SightingFields";
import {
	buildSingleWineHandoff,
	MAX_HANDOFF_PHOTOS,
	singleWineCandidate,
	takePhotosForEntry,
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

	it("既存セラーと一致していても候補にはする(切り替え後に戻れる)", () => {
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

	it("自動切り替えの荷物として印を付ける", () => {
		const handoff = buildSingleWineHandoff(candidate(), []);
		expect(handoff.reason).toBe("single_wine");
		// 場所・撮影日を触っていない回は目撃記録の下書きを持たない
		expect(handoff.sighting).toBeUndefined();
	});

	// ウィザードで入力した場所・撮影日を記録フォームの「見かけた記録」へ渡す(#495)。
	// 以前はここで捨て、引き継げない旨を画面で案内していた。
	it("写真の場所・撮影日を目撃記録の下書きとして引き継ぐ", () => {
		const sighting: WineSightingDraft = {
			placeId: "p1",
			newPlaceName: "",
			seenOn: "2026-08-09",
			price: "",
			memo: "",
		};
		expect(buildSingleWineHandoff(candidate(), [], sighting).sighting).toEqual(
			sighting,
		);
	});
});

describe("takePhotosForEntry", () => {
	it("上限を超えた分は落とし、落とした枚数を伝える", () => {
		const files = Array.from({ length: MAX_HANDOFF_PHOTOS + 3 }, (_, i) =>
			photoFile(`p${i}.jpg`),
		);
		const taken = takePhotosForEntry(files);
		expect(taken.files).toHaveLength(MAX_HANDOFF_PHOTOS);
		expect(taken.files.at(-1)?.name).toBe(`p${MAX_HANDOFF_PHOTOS - 1}.jpg`);
		expect(taken.droppedPhotoCount).toBe(3);
	});

	it("上限以下ならそのまま", () => {
		const taken = takePhotosForEntry([photoFile("a.jpg"), photoFile("b.jpg")]);
		expect(taken.files).toHaveLength(2);
		expect(taken.droppedPhotoCount).toBe(0);
	});

	it("1枚も選んでいなければ空", () => {
		const taken = takePhotosForEntry([]);
		expect(taken.files).toEqual([]);
		expect(taken.droppedPhotoCount).toBe(0);
	});
});
