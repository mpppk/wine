import { describe, expect, it } from "vitest";
import { AOPS } from "./aops-data";
import { AOP_CENTROIDS, getCentroid } from "./centroids";
import { REGIONS } from "./regions";
import { POLYGONLESS_IDAPP_MIN } from "./types";

// aop-centroids.json (build:centroids の出力) と aops.json の整合性を検証する。
// GeoJSON再生成後に build:centroids を忘れた場合の乖離をここで検出する。

describe("セントロイドデータの整合性", () => {
	it("すべてのAOPにセントロイドがある(ポリゴンを持つ帯のみ)", () => {
		// 個別クリマ・合成総称ノード(idApp>=930000)はポリゴンを持たないため対象外。
		for (const aop of AOPS.filter((a) => a.idApp < POLYGONLESS_IDAPP_MIN)) {
			expect(getCentroid(aop.id), aop.id).toBeDefined();
		}
	});

	it("aops.json に存在しない孤児キーがない", () => {
		const ids = new Set(AOPS.map((a) => a.id));
		for (const key of Object.keys(AOP_CENTROIDS)) {
			expect(ids.has(key), key).toBe(true);
		}
	});

	it("セントロイドが所属地域のbounds内にある", () => {
		for (const aop of AOPS) {
			const region = REGIONS.find((r) => r.id === aop.region);
			const bounds = region?.bounds;
			expect(bounds, aop.region).toBeDefined();
			if (!bounds) continue;
			const [west, south, east, north] = bounds;
			const centroid = getCentroid(aop.id);
			if (!centroid) continue;
			const [lng, lat] = centroid;
			// 簡略化やコミューン輪郭由来の誤差を見込んで±0.1°許容
			expect(lng, `${aop.id} lng`).toBeGreaterThanOrEqual(west - 0.1);
			expect(lng, `${aop.id} lng`).toBeLessThanOrEqual(east + 0.1);
			expect(lat, `${aop.id} lat`).toBeGreaterThanOrEqual(south - 0.1);
			expect(lat, `${aop.id} lat`).toBeLessThanOrEqual(north + 0.1);
		}
	});
});
