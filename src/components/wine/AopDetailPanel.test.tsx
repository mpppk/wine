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

// ユーザ固有の欄(マイセラー・参考リンク)は、ログイン制御とデータ取得を含むため
// 呼び出し元が組み立てて差し込む。パネル側は「渡されたら出す・渡されなければ出さない」
// だけを守る(embed 等の公開ビューは渡さないので何も出てはいけない)。
describe("AopDetailPanel のユーザ固有スロット", () => {
	it("cellarWinesSlot を渡すと描画する", () => {
		render(
			<AopDetailPanel aop={AOP} cellarWinesSlot={<p>マイセラーの中身</p>} />,
		);
		expect(screen.getByText("マイセラーの中身")).toBeTruthy();
	});

	it("スロット未指定なら何も出さない", () => {
		render(<AopDetailPanel aop={AOP} />);
		expect(screen.queryByText("マイセラーの中身")).toBeNull();
	});
});

// クイズ導線は「このAOPの関連クイズをどこまで解いたか」をボタン自身で示す。
// アイコンだけでは残り問題数が落ちるので、ラベル(状態で3通り)と進捗ピル
// (solved/total)を併記し、全問正解時はボタンの役割を「復習」に切り替える。
describe("AopDetailPanel のクイズ導線", () => {
	/** クイズボタンの表示テキスト(ラベル + 進捗ピル) */
	function quizButtonText(): string {
		return (
			screen.getByRole("button", { name: /クイズ|残り/ }).textContent ?? ""
		);
	}

	it("進捗を渡さなければ分数を出さず出題数だけを示す(未ログイン)", () => {
		render(
			<AopDetailPanel
				aop={AOP}
				quizQuestionCount={20}
				onStartQuiz={() => {}}
			/>,
		);
		const text = quizButtonText();
		expect(text).toContain("このAOPのクイズに挑戦");
		expect(text).toContain("クイズ20問");
		expect(text).not.toContain("0/20");
	});

	it("未着手なら「挑戦」のまま 0/N を示す", () => {
		render(
			<AopDetailPanel
				aop={AOP}
				quizQuestionCount={20}
				quizProgress={{ solved: 0, total: 20 }}
				onStartQuiz={() => {}}
			/>,
		);
		const text = quizButtonText();
		expect(text).toContain("このAOPのクイズに挑戦");
		expect(text).toContain("0/20");
	});

	// 出題側は既定で未正解のみを出す(quiz-service の filterUnsolved)ため、
	// 「残りN問」は実際に出題される問題数と一致する
	it("学習中は残りの未正解数をラベルに出す", () => {
		render(
			<AopDetailPanel
				aop={AOP}
				quizQuestionCount={20}
				quizProgress={{ solved: 12, total: 20 }}
				onStartQuiz={() => {}}
			/>,
		);
		const text = quizButtonText();
		expect(text).toContain("残り8問に挑戦");
		expect(text).toContain("12/20");
	});

	it("全問正解済みならボタンの役割を「復習」に切り替える", () => {
		render(
			<AopDetailPanel
				aop={AOP}
				quizQuestionCount={20}
				quizProgress={{ solved: 20, total: 20 }}
				onStartQuiz={() => {}}
			/>,
		);
		const text = quizButtonText();
		expect(text).toContain("このAOPのクイズを復習");
		expect(text).toContain("20/20");
	});

	it("出題できる問題が無ければクイズボタン自体を出さない", () => {
		render(
			<AopDetailPanel aop={AOP} quizQuestionCount={0} onStartQuiz={() => {}} />,
		);
		expect(screen.queryByRole("button", { name: /クイズ/ })).toBeNull();
	});
});
