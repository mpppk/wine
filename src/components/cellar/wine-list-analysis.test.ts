import { describe, expect, it } from "vitest";
import { resolveBatchPhotoFallback } from "./wine-list-analysis";

// 一括登録の確定後に「写真をどう保存するか」の判定(#617)。写真は常にジョブから
// バッチへ引き継ぐので、アップロードは引き継げなかったときだけの逃げ道になる。
describe("resolveBatchPhotoFallback", () => {
	it("引き継げた回は何も送らない", () => {
		expect(
			resolveBatchPhotoFallback({
				adopted: 3,
				localCount: 3,
				analyzedCount: 3,
			}),
		).toBe("none");
	});

	it("受け取って開いた回は手元に写真が無いので送りようがない", () => {
		expect(
			resolveBatchPhotoFallback({
				adopted: 0,
				localCount: 0,
				analyzedCount: 2,
			}),
		).toBe("none");
	});

	it("引き継げず手元に同じ枚数があれば送る(24時間で回収された後など)", () => {
		expect(
			resolveBatchPhotoFallback({
				adopted: 0,
				localCount: 2,
				analyzedCount: 2,
			}),
		).toBe("upload");
	});

	it("解析後に写真を足した回は送らない(写真番号の指す先がズレる)", () => {
		expect(
			resolveBatchPhotoFallback({
				adopted: 0,
				localCount: 3,
				analyzedCount: 2,
			}),
		).toBe("unavailable");
	});
});
