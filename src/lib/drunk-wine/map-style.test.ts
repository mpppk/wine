import { describe, expect, it } from "vitest";
import {
	STATUS_COLORS,
	STATUS_EMPTY_COLOR,
	statusFillColorExpr,
	statusLineColorExpr,
} from "./map-style";
import { WINE_STATUS_IDS } from "./status";

// 所有状態モードの色式。maplibre の式は typecheck / build / test をすべて通り抜けて
// 実行時にだけ壊れる(#184 と同じ類型)ため、式の中身を静的に固定して
// 「状態を足したのに色を足し忘れた」を検出できるようにする。

describe("STATUS_COLORS", () => {
	it("すべての所有状態に fill / line がある", () => {
		for (const id of WINE_STATUS_IDS) {
			expect(STATUS_COLORS[id].fill).toMatch(/^#[0-9a-f]{6}$/i);
			expect(STATUS_COLORS[id].line).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("状態どうしで色が重複しない(3状態が地図で区別できる)", () => {
		const fills = WINE_STATUS_IDS.map((id) => STATUS_COLORS[id].fill);
		expect(new Set(fills).size).toBe(fills.length);
	});

	it("区分モードの赤系・進捗モードの緑系と衝突しない色を選んでいる", async () => {
		// 具体的な色は dataviz skill の validate_palette で検証済み。ここでは
		// 既存2モードのパレットと同じ値を使い回していないことだけを固定する。
		const { KIND_COLORS, PROGRESS_BUCKETS } = await import(
			"#/lib/wine/map-style"
		);
		const existing = new Set([
			...Object.values(KIND_COLORS).map((c) => c.fill),
			...PROGRESS_BUCKETS.map((b) => b.fill),
		]);
		for (const id of WINE_STATUS_IDS) {
			expect(existing.has(STATUS_COLORS[id].fill)).toBe(false);
		}
	});
});

describe("statusFillColorExpr / statusLineColorExpr", () => {
	it("feature-state.status を match で色に写す", () => {
		const expr = statusFillColorExpr() as unknown as unknown[];
		expect(expr[0]).toBe("match");
		// 未設定は "" に落ちてどの状態にも一致しない = 既定色になる
		expect(expr[1]).toEqual(["coalesce", ["feature-state", "status"], ""]);
		expect(expr.at(-1)).toBe(STATUS_EMPTY_COLOR.fill);
	});

	it("すべての所有状態が分岐に含まれる", () => {
		for (const expr of [statusFillColorExpr(), statusLineColorExpr()]) {
			const flat = expr as unknown as unknown[];
			for (const id of WINE_STATUS_IDS) {
				expect(flat).toContain(id);
			}
		}
	});

	it("状態ごとに対応する色が並ぶ", () => {
		const fill = statusFillColorExpr() as unknown as unknown[];
		const line = statusLineColorExpr() as unknown as unknown[];
		for (const id of WINE_STATUS_IDS) {
			expect(fill[fill.indexOf(id) + 1]).toBe(STATUS_COLORS[id].fill);
			expect(line[line.indexOf(id) + 1]).toBe(STATUS_COLORS[id].line);
		}
	});
});
