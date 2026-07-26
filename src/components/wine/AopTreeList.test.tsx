import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Aop, Subregion } from "#/lib/wine/types";
import { AopTreeList } from "./AopTreeList";

// ボンヌ・マール(シャンボール・ミュジニー / モレ・サン・ドニ)のように複数村に
// またがる畑は、リスト上に村ごとの行として複数回現れる。行の同一性は AOP id では
// なく rowKey(祖先ノードのパス)で決まる。2つ目以降の行を押したときに1つ目の行へ
// スクロールが飛ぶ不具合の回帰テスト。

function aop(partial: Partial<Aop> & Pick<Aop, "id" | "kind">): Aop {
	return {
		idApp: 1,
		name: partial.id,
		shortName: partial.id,
		nameJa: partial.id,
		region: "bourgogne",
		subregionId: "sub-a",
		colors: ["red"],
		grapes: [{ varietyId: "pinot-noir", role: "principal" }],
		soil: "-",
		producers: [{ name: "-" }],
		description: "-",
		...partial,
	};
}

const SUBREGIONS: Subregion[] = [{ id: "sub-a", nameJa: "コート・ド・ニュイ" }];

const AOPS: Aop[] = [
	aop({ id: "chambolle-musigny", kind: "village", nameJa: "シャンボール" }),
	aop({ id: "morey-saint-denis", kind: "village", nameJa: "モレ" }),
	aop({
		id: "bonnes-mares",
		kind: "vineyard",
		nameJa: "ボンヌ・マール",
		villageAopIds: ["chambolle-musigny", "morey-saint-denis"],
	}),
];

const VISIBLE = new Set(AOPS.map((a) => a.id));

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());

/** リストを「縦スクロールする器」の中に描画する(スクロール祖先の探索対象になる) */
function Harness() {
	const [selectedAopId, setSelectedAopId] = useState<string | undefined>();
	return (
		<div data-testid="scroller" style={{ overflowY: "auto" }}>
			{/* 地図クリックや前へ/次へのような、リスト外からの選択を模す */}
			<button type="button" onClick={() => setSelectedAopId("bonnes-mares")}>
				外から選択
			</button>
			<AopTreeList
				aops={AOPS}
				subregions={SUBREGIONS}
				visibleAopIds={VISIBLE}
				selectedAopId={selectedAopId}
				onSelect={setSelectedAopId}
			/>
		</div>
	);
}

/** jsdom はレイアウトしないため、スクロール判定に使う矩形を実測値の代わりに固定する */
function stubRect(el: HTMLElement, top: number, height = 20) {
	el.getBoundingClientRect = () =>
		({ top, bottom: top + height, height }) as DOMRect;
}

function setup(rowTops: [number, number]) {
	render(<Harness />);
	const scroller = screen.getByTestId("scroller");
	// 器の可視範囲は 0〜100px とする
	stubRect(scroller, 0, 100);
	const rows = screen.getAllByRole("button", { name: /ボンヌ・マール/ });
	expect(rows).toHaveLength(2);
	stubRect(rows[0] as HTMLElement, rowTops[0]);
	stubRect(rows[1] as HTMLElement, rowTops[1]);
	return { scroller, rows: rows as HTMLElement[] };
}

describe("AopTreeList", () => {
	it("複数村にまたがる畑の行はそれぞれ別の rowKey を持つ", () => {
		const { rows } = setup([0, 0]);
		expect(rows[0]?.dataset.aopRowKey).toBe(
			"sub-a/chambolle-musigny/bonnes-mares",
		);
		expect(rows[1]?.dataset.aopRowKey).toBe(
			"sub-a/morey-saint-denis/bonnes-mares",
		);
	});

	it("2つ目の行を押しても1つ目の行へスクロールしない", () => {
		// 1つ目の行は可視範囲より上へスクロールアウト、2つ目は可視範囲内
		const { scroller, rows } = setup([-200, 40]);
		fireEvent.click(rows[1] as HTMLElement);
		// 押した行は既に見えているので動かない(以前は1つ目の行へ -200 戻していた)
		expect(scroller.scrollTop).toBe(0);
	});

	it("押した行が詳細パネルに隠れる位置なら、その行だけを送り出す", () => {
		// 2つ目の行が可視範囲の下端(100px)からはみ出している
		const { scroller, rows } = setup([-200, 90]);
		fireEvent.click(rows[1] as HTMLElement);
		expect(scroller.scrollTop).toBe(10);
	});

	it("1つ目の行を押したときはその行へスクロールする", () => {
		const { scroller, rows } = setup([-200, 40]);
		fireEvent.click(rows[0] as HTMLElement);
		expect(scroller.scrollTop).toBe(-200);
	});

	it("リスト外からの選択では現在位置から最も近い行へスクロールする", () => {
		// 1つ目は 300px 上、2つ目は 60px 下。押された行が無いので近い方(2つ目)を選ぶ
		const { scroller } = setup([-300, 140]);
		fireEvent.click(screen.getByRole("button", { name: "外から選択" }));
		expect(scroller.scrollTop).toBe(60);
	});
});
