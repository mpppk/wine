import { describe, expect, it } from "vitest";
import { downscaleForAnalysis, unresizablePhotoMessage } from "./photo-resize";

// jsdom には createImageBitmap / canvas の実装が無いため、downscaleImage は必ず
// 「縮小できなかった」経路を通る。これは実機で iOS のメモリ不足や巨大な解像度で
// 起きる状態そのもので、AI解析へ送る経路がその写真をどう扱うかを固定する
// (原寸のまま送るとアップロードが完了せず「Failed to fetch」になる)。

function photoFile(bytes: number): File {
	return new File([new Uint8Array(bytes)], "photo.jpg", { type: "image/jpeg" });
}

const OPTIONS = { maxDimension: 1600, quality: 0.85, photoNumber: 2 };

describe("downscaleForAnalysis", () => {
	it("縮小できず、かつ大きい写真は送らずに理由付きで落とす", async () => {
		await expect(
			downscaleForAnalysis(photoFile(3 * 1024 * 1024), OPTIONS),
		).rejects.toThrow(unresizablePhotoMessage(2));
	});

	it("縮小できなくても小さい写真はそのまま送る(サーバのAIに判断させる)", async () => {
		const file = photoFile(100 * 1024);
		await expect(downscaleForAnalysis(file, OPTIONS)).resolves.toBe(file);
	});
});

describe("unresizablePhotoMessage", () => {
	it("何枚目かと次に取れる行動を示す", () => {
		expect(unresizablePhotoMessage(3)).toContain("3枚目");
		expect(unresizablePhotoMessage(3)).toContain("解像度の低い写真");
	});
});
