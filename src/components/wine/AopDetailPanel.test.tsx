import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Aop } from "#/lib/wine/types";
import { AopDetailPanel } from "./AopDetailPanel";

// 生産者リストの表示規約: 受賞・格付けを持つ生産者を上位に寄せ、購入リンク
// ダイアログを開く前に受賞歴が分かるバッジを行に出す。
// 生産者名は PRODUCER_INFO の実キーを使う(辞書を引けないと受賞が付かない)。

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());

const AOP: Aop = {
	id: "test-village",
	idApp: 1,
	name: "Test",
	shortName: "Test",
	nameJa: "テスト村",
	region: "bourgogne",
	subregionId: "cote-de-nuits",
	kind: "village",
	colors: ["red"],
	grapes: [{ varietyId: "pinot-noir", role: "principal" }],
	soil: "-",
	producers: [
		{ name: "無名の造り手" },
		{ name: "Domaine Dujac" }, // MICHELIN Grapes 2グレープ
		{ name: "Domaine de la Romanée-Conti", note: "モノポール" }, // 3グレープ
	],
	description: "-",
};

/** 「主要な生産者」セクションの各行のテキスト(表示順) */
function producerRows(): string[] {
	const heading = screen.getByRole("heading", { name: "主要な生産者" });
	const list = heading.closest("section")?.querySelector("ul");
	if (!list) throw new Error("生産者リストが見つからない");
	return [...list.querySelectorAll(":scope > li")].map(
		(li) => li.textContent ?? "",
	);
}

describe("AopDetailPanel の生産者リスト", () => {
	it("受賞・格付けを持つ生産者を上位に、階級順で並べる", () => {
		render(<AopDetailPanel aop={AOP} />);
		const rows = producerRows();
		expect(rows[0]).toContain("Domaine de la Romanée-Conti");
		expect(rows[1]).toContain("Domaine Dujac");
		expect(rows[2]).toContain("無名の造り手");
	});

	it("受賞歴のある生産者の行に、タップ前から見えるバッジを出す", () => {
		render(<AopDetailPanel aop={AOP} />);
		expect(
			screen.getByLabelText("受賞・格付け: MICHELIN Grapes 3グレープ")
				.textContent,
		).toBe("3グレープ");
		expect(
			screen.getByLabelText("受賞・格付け: MICHELIN Grapes 2グレープ")
				.textContent,
		).toBe("2グレープ");
	});

	it("受賞を持たない生産者にはバッジを出さない", () => {
		render(<AopDetailPanel aop={AOP} />);
		expect(producerRows()[2]).toBe("無名の造り手");
	});

	it("note はバッジと併存する", () => {
		render(<AopDetailPanel aop={AOP} />);
		expect(producerRows()[0]).toContain("（モノポール）");
	});
});
