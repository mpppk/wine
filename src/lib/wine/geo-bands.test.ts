import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// ジオデータ生成スクリプト側の入口(Node ESM)。TS からそのまま import して、
// アプリ側の定数と同じ実体を指していることを固定する。
import { POLYGONLESS_IDAPP_MIN as SCRIPT_MIN } from "../../../scripts/geo-bands.mjs";
import { POLYGONLESS_IDAPP_MIN } from "./types";

// idApp の帯規約の定数は、以前 types.ts と geodata スクリプト2本にリテラルで
// 3重複製されていた(Issue #407)。同期漏れしても**生成物が無言で変わるだけ**で、
// data-integrity.test.ts は TS 側の定数としか突き合わせないため「古い定数で生成された
// 成果物」との乖離を検出できなかった。ここは境界をまたぐ唯一の突き合わせ点。

describe("POLYGONLESS_IDAPP_MIN", () => {
	it("アプリ側とスクリプト側が同じ値を見る", () => {
		expect(SCRIPT_MIN).toBe(POLYGONLESS_IDAPP_MIN);
	});

	it("JSON(SSOT)の値がそのまま公開される", () => {
		const raw = JSON.parse(
			fs.readFileSync(
				path.join(process.cwd(), "src/lib/wine/geo-bands.json"),
				"utf8",
			),
		) as { polygonlessIdAppMin: number };
		expect(POLYGONLESS_IDAPP_MIN).toBe(raw.polygonlessIdAppMin);
		// 帯は 900001/910001/920001/930001 と積み増しされてきた合成ID空間の境界。
		// 桁を取り違えた値(例: 93000)が入ると実エントリまで除外されるので範囲も見る。
		expect(Number.isInteger(POLYGONLESS_IDAPP_MIN)).toBe(true);
		expect(POLYGONLESS_IDAPP_MIN).toBeGreaterThan(100000);
	});

	it("スクリプトに閾値のリテラルが残っていない(複製の再発防止)", () => {
		// 定数を使わずリテラルで書き戻すと、この test だけが気づける。
		for (const file of ["build-aop-geodata.mjs", "build-aop-centroids.mjs"]) {
			const src = fs.readFileSync(
				path.join(process.cwd(), "scripts", file),
				"utf8",
			);
			expect(src, file).not.toMatch(
				new RegExp(`\\b${POLYGONLESS_IDAPP_MIN}\\b`),
			);
			expect(src, file).toContain("geo-bands.mjs");
		}
	});
});
