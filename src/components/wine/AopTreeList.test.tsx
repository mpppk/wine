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

// 区分(格付けバッジ)と進捗(正解ピル)は行の別チャンネルを使うため排他にしない。
// 色分けモードはドットの色だけに効く、という切り分けの回帰テスト。

const BADGE_AOPS: Aop[] = [
	aop({ id: "gevrey", kind: "village", nameJa: "ジュヴレ" }),
	// 格付けを持つ通常の畑(AOC)
	aop({
		id: "chambertin",
		kind: "vineyard",
		nameJa: "シャンベルタン",
		villageAopIds: ["gevrey"],
		tags: ["grand-cru"],
	}),
	// 格付けを持つが法的に独立AOCではない畑(シャブリ特級クリマ等と同じ形)
	aop({
		id: "les-clos",
		kind: "vineyard",
		nameJa: "レ・クロ",
		villageAopIds: ["gevrey"],
		tags: ["grand-cru"],
		isAppellation: false,
	}),
];

const BADGE_VISIBLE = new Set(BADGE_AOPS.map((a) => a.id));

const BADGE_PROGRESS: Record<string, { solved: number; total: number }> = {
	chambertin: { solved: 3, total: 12 },
	"les-clos": { solved: 0, total: 4 },
};

function renderBadges(props: {
	colorMode?: "kind" | "progress";
	isAuthenticated?: boolean;
}) {
	render(
		<AopTreeList
			aops={BADGE_AOPS}
			subregions={SUBREGIONS}
			visibleAopIds={BADGE_VISIBLE}
			onSelect={() => {}}
			rowProgressByAopId={BADGE_PROGRESS}
			{...props}
		/>,
	);
	return {
		chambertin: screen.getByRole("button", { name: /シャンベルタン/ }),
	};
}

describe("AopTreeList のバッジ表示", () => {
	it("区分モードでも格付けバッジと進捗ピルが同じ行に並ぶ", () => {
		const { chambertin } = renderBadges({});
		expect(chambertin.textContent).toContain("特級");
		expect(chambertin.textContent).toContain("3/12");
	});

	it("進捗モードでも格付けバッジが消えない", () => {
		const { chambertin } = renderBadges({ colorMode: "progress" });
		expect(chambertin.textContent).toContain("特級");
		expect(chambertin.textContent).toContain("3/12");
	});

	it("未ログイン時は区分モードでは進捗ピルを出さない", () => {
		const { chambertin } = renderBadges({ isAuthenticated: false });
		expect(chambertin.textContent).toContain("特級");
		expect(chambertin.textContent).not.toContain("クイズ");
	});

	it("未ログイン時に進捗モードを選ぶと出題数を中立表示する", () => {
		const { chambertin } = renderBadges({
			isAuthenticated: false,
			colorMode: "progress",
		});
		expect(chambertin.textContent).toContain("特級");
		// 正解が記録されないため分数ではなく出題数を出す
		expect(chambertin.textContent).toContain("クイズ12問");
		expect(chambertin.textContent).not.toContain("0/12");
	});

	it("非AOCの畑はテキストピルを持たず、ドットのリングと読み上げラベルで示す", () => {
		renderBadges({});
		// 非AOC行(バッジが3つ並ぶのを避けるためテキストピルは出さない)
		const lesClos = screen.getByRole("button", { name: /レ・クロ/ });
		expect(lesClos.querySelector("[title='非AOC']")).not.toBeNull();
		expect(lesClos.textContent).toContain("非AOC"); // sr-only
		expect(lesClos.textContent).toContain("特級");
		expect(lesClos.textContent).toContain("0/4");
		// AOCである畑にはリングもラベルも付かない
		const chambertin = screen.getByRole("button", { name: /シャンベルタン/ });
		expect(chambertin.querySelector("[title='非AOC']")).toBeNull();
		expect(chambertin.textContent).not.toContain("非AOC");
	});
});
