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

function renderCard(
	cardPartial: Partial<WineListCandidate>,
	photoPreviews: readonly string[] = [],
) {
	const [card] = buildImportCards([candidate(cardPartial)]);
	if (!card) throw new Error("unreachable");
	const rendered = render(
		<ImportCandidateCard
			card={card}
			photoPreviews={photoPreviews}
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

	it("プレビューが無ければ手元写真のサムネイルは出さない(受け取って開いた回)", () => {
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

// 利用画像のサムネイル(IMPL-5)。手元のバッチ写真は登録時に使われる1枚と同じもの
// (`bottlePhotoIndex ?? photoIndexes[0]`)を自動選択して出す。overlay は web 由来だけ。
describe("ImportCandidateCard の利用画像サムネイル", () => {
	const PREVIEWS = ["blob:photo-0", "blob:photo-1", "blob:photo-2"];

	it("bottle_photo_index があればその写真を出す(複数関連時の自動選択)", () => {
		const { container } = renderCard(
			{
				photoKind: "bottle",
				photoIndexes: [0, 2],
				bottlePhotoIndex: 2,
			},
			PREVIEWS,
		);
		expect(
			screen.getByRole("button", { name: "Baroloの写真を拡大" }),
		).toBeTruthy();
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"blob:photo-2",
		);
		// 手元写真なので overlay・バッジは出さない
		expect(container.textContent).not.toContain("WEB");
	});

	it("bottle_photo_index が無ければ関連写真の先頭を出す", () => {
		const { container } = renderCard(
			{ photoKind: "bottle", photoIndexes: [1, 2] },
			PREVIEWS,
		);
		expect(
			screen.getByRole("button", { name: "Baroloの写真を拡大" }),
		).toBeTruthy();
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"blob:photo-1",
		);
	});

	it("既存一致のカードでも目撃記録の写真(手元)を出す", () => {
		const { container } = renderCard(
			{
				photoKind: "bottle",
				photoIndexes: [1],
				existing: { id: "e1", name: "Barolo", vintage: 2018, status: "owned" },
			},
			PREVIEWS,
		);
		expect(
			screen.getByRole("button", { name: "Baroloの写真を拡大" }),
		).toBeTruthy();
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"blob:photo-1",
		);
	});

	it("既存一致の web 由来カードは web 画像を出さず手元写真に落とす", () => {
		const { container } = renderCard(
			{
				photoKind: "web",
				photoIndexes: [0],
				imageUrl: "https://example.com/barolo.jpg",
				existing: { id: "e1", name: "Barolo", vintage: 2018, status: "owned" },
			},
			PREVIEWS,
		);
		// web は取り込まないので overlay なし・手元写真のサムネイルだけ
		expect(screen.queryByRole("button", { name: /WEB画像/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Baroloの写真を拡大" }),
		).toBeTruthy();
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"blob:photo-0",
		);
	});
});
