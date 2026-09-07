import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import { ImportCandidateCard } from "./ImportCandidateCard";
import { buildImportCards } from "./import-candidates";

// レビューカードの WEB 由来表示(IMPL-4)。overlay の有無は card.photoKind の
// 1箇所だけを見て決める(ここで imageUrl の有無判定を書き直さない)。

afterEach(() => cleanup());

function candidate(
	partial: Partial<WineListCandidate> = {},
): WineListCandidate {
	return {
		suggestions: { name: "Barolo" },
		photoIndexes: [1],
		photoKind: "bottle",
		...partial,
	};
}

function renderCard(cardPartial: Partial<WineListCandidate>) {
	const [card] = buildImportCards([candidate(cardPartial)]);
	if (!card) throw new Error("unreachable");
	const rendered = render(
		<ImportCandidateCard
			card={card}
			onChange={() => {}}
			onChangeValues={() => {}}
		/>,
	);
	return { card, ...rendered };
}

describe("ImportCandidateCard の WEB 由来表示", () => {
	it("web 由来の新規銘柄にはサムネイルと overlay・バッジを出す", () => {
		renderCard({
			photoKind: "web",
			imageUrl: "https://example.com/barolo.jpg",
			imageNote: "2019年のラベル画像です",
		});
		// サムネイル(タップで拡大。由来を名前に含める)
		expect(
			screen.getByRole("button", { name: "Baroloの写真(WEB画像)を拡大" }),
		).toBeTruthy();
		// overlay と inline バッジは共通コンポーネントから出る
		expect(screen.getAllByText("WEB").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("WEB画像")).toBeTruthy();
		// ズレの注記はバッジの近傍に出る
		expect(screen.getByText("2019年のラベル画像です")).toBeTruthy();
	});

	it("手元写真の銘柄には overlay もサムネイルも出さない", () => {
		const { container } = renderCard({
			photoKind: "bottle",
			bottlePhotoIndex: 1,
		});
		expect(screen.queryByRole("button", { name: /WEB画像/ })).toBeNull();
		expect(container.textContent).not.toContain("WEB");
	});

	it("既存一致のカードには web 表示を出さない(取り込まないため)", () => {
		const { container } = renderCard({
			photoKind: "web",
			imageUrl: "https://example.com/barolo.jpg",
			existing: { id: "e1", name: "Barolo", vintage: 2018, status: "owned" },
		});
		expect(screen.queryByRole("button", { name: /WEB画像/ })).toBeNull();
		expect(container.textContent).not.toContain("WEB");
	});
});
