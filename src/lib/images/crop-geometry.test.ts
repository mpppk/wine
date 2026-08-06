import { describe, expect, it } from "vitest";
import {
	CROP_MIN_SIZE,
	CROP_PADDING,
	resolveCropBox,
	resolveOutputWidth,
} from "./crop-geometry";

// モデルが出す座標を、そのまま切っても壊れない範囲へ均す層。
//
// **モデルの座標精度に賭けない**のがこのモジュールの存在理由。実測では
// gpt-5.6-luna はラベルの位置を手作業とほぼ同じ精度で指せたが、それは1枚での結果で、
// 外したときに「読みたい文字が枠外に落ちて、モデルからは文字が途切れているとしか
// 見えない」形の失敗をするのは避けたい。

const image = { width: 1000, height: 2000 };

describe("resolveCropBox", () => {
	it("素直な指定はパディングぶんだけ広げて返す", () => {
		const { applied } = resolveCropBox(
			{ x: 0.3, y: 0.4, width: 0.2, height: 0.3 },
			image,
		);
		expect(applied.width).toBeCloseTo(0.2 + CROP_PADDING * 2, 5);
		expect(applied.height).toBeCloseTo(0.3 + CROP_PADDING * 2, 5);
		// 中心は保つ
		expect(applied.x + applied.width / 2).toBeCloseTo(0.4, 5);
		expect(applied.y + applied.height / 2).toBeCloseTo(0.55, 5);
	});

	it("正規化座標をピクセルへ落とす", () => {
		const { pixels } = resolveCropBox(
			{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
			image,
		);
		expect(pixels.left).toBe(230);
		expect(pixels.top).toBe(460);
		expect(pixels.width).toBe(540);
		expect(pixels.height).toBe(1080);
	});

	describe("外れた指定を吸収する", () => {
		it("狭すぎる指定は中心を保って最小サイズまで広げる", () => {
			// 狭すぎる指定は「読みたい文字の一部しか入らない」失敗になりやすい
			const { applied } = resolveCropBox(
				{ x: 0.5, y: 0.5, width: 0.01, height: 0.01 },
				image,
			);
			expect(applied.width).toBeCloseTo(CROP_MIN_SIZE, 5);
			expect(applied.height).toBeCloseTo(CROP_MIN_SIZE, 5);
			expect(applied.x + applied.width / 2).toBeCloseTo(0.505, 5);
		});

		it("画像からはみ出したら縮めずにずらす", () => {
			// 縮めると倍率が上がって読みたい範囲が枠外に出る。ずらすだけなら入る余地が残る。
			const { applied } = resolveCropBox(
				{ x: 0.9, y: 0.9, width: 0.3, height: 0.3 },
				image,
			);
			expect(applied.width).toBeCloseTo(0.3 + CROP_PADDING * 2, 5);
			expect(applied.x + applied.width).toBeCloseTo(1, 5);
		});

		it("負の座標も範囲内へ収める", () => {
			const { applied, pixels } = resolveCropBox(
				{ x: -0.2, y: -0.1, width: 0.3, height: 0.3 },
				image,
			);
			expect(applied.x).toBe(0);
			expect(pixels.left).toBe(0);
			expect(pixels.top).toBe(0);
		});

		it("画像より大きい指定は全体にクランプする", () => {
			const { applied, pixels } = resolveCropBox(
				{ x: 0, y: 0, width: 2, height: 2 },
				image,
			);
			expect(applied.width).toBe(1);
			expect(pixels.width).toBe(image.width);
			expect(pixels.height).toBe(image.height);
		});

		it("数値が壊れていても throw せず全体を返す", () => {
			// モデルの書き損じで解析そのものを失敗させない
			const { pixels } = resolveCropBox(
				{ x: Number.NaN, y: 0.5, width: -1, height: 0 },
				image,
			);
			expect(pixels.width).toBe(image.width);
			expect(pixels.left).toBe(0);
		});
	});

	it("丸めで幅0にならない", () => {
		const tiny = { width: 3, height: 3 };
		const { pixels } = resolveCropBox(
			{ x: 0.5, y: 0.5, width: 0.01, height: 0.01 },
			tiny,
		);
		expect(pixels.width).toBeGreaterThanOrEqual(1);
		expect(pixels.height).toBeGreaterThanOrEqual(1);
	});
});

describe("resolveOutputWidth", () => {
	it("上限より小さい切り出しは拡大しない(undefined)", () => {
		// 画素を水増ししても情報は増えず、入力トークンだけが増える
		expect(
			resolveOutputWidth({ left: 0, top: 0, width: 400, height: 800 }, 1024),
		).toBeUndefined();
	});

	it("上限を超える切り出しは長辺が上限になるよう縮める", () => {
		expect(
			resolveOutputWidth({ left: 0, top: 0, width: 1000, height: 2000 }, 1000),
		).toBe(500);
	});

	it("横長でも長辺で判定する", () => {
		expect(
			resolveOutputWidth({ left: 0, top: 0, width: 2000, height: 500 }, 1000),
		).toBe(1000);
	});
});
