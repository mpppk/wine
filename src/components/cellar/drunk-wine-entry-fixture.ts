import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";

// 単体テスト用の DrunkWineEntry 雛形。各テストにコピペしていた BASE を SSOT 化
// したもの(jscpd の重複検出で CI が落ちるため、直接書かずここから作ること)。
// 毎回新しいオブジェクトを返すので、テスト間で状態を共有しない。
export function makeDrunkWineEntry(
	overrides: Partial<DrunkWineEntry> = {},
): DrunkWineEntry {
	return {
		id: "e1",
		name: "テストワイン",
		status: "finished",
		lastDrankOn: null,
		tastingCount: 0,
		lastSeenOn: null,
		sightingCount: 0,
		aopId: null,
		aopNameJa: null,
		regionId: null,
		countryId: null,
		lastRating: null,
		lastMemo: null,
		vintage: null,
		grapeVarietyIds: [],
		producer: null,
		note: null,
		price: null,
		referenceLinks: [],
		prices: [],
		photoUrls: [],
		thumbUrls: [],
		photoKinds: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}
