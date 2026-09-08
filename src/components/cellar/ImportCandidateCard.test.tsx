import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import { ImportCandidateCard } from "./ImportCandidateCard";
import { buildImportCards, type ImportCardState } from "./import-candidates";

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
	onChange: (patch: Partial<ImportCardState>) => void = () => {},
) {
	const [card] = buildImportCards([candidate(cardPartial)]);
	if (!card) throw new Error("unreachable");
	const rendered = render(
		<ImportCandidateCard
			card={card}
			photoPreviews={photoPreviews}
			onChange={onChange}
			onChangeValues={() => {}}
		/>,
	);
	return { card, ...rendered };
}

describe("ImportCandidateCard の WEB 由来表示", () => {
	it("web 由来の新規銘柄にはサムネイルと overlay を出す(文字バッジなし)", () => {
		const { container } = renderCard({
			photoKind: "web",
			imageUrl: "https://example.com/barolo.jpg",
			imageNote: "2019年のラベル画像です",
		});
		// サムネイル(タップで拡大。由来を名前に含める)
		expect(
			screen.getByRole("button", { name: "Baroloの写真(WEB画像)を拡大" }),
		).toBeTruthy();
		// 由来表示は overlay のみ。文字バッジ(何枚目・WEB画像)は出さない
		expect(screen.getAllByText("WEB").length).toBeGreaterThanOrEqual(1);
		expect(container.textContent).not.toContain("WEB画像");
		expect(container.textContent).not.toContain("枚目");
		// ズレの注記はアイコンのみ。タップで全文が展開される
		expect(container.textContent).not.toContain("2019年のラベル画像です");
		fireEvent.click(
			screen.getByRole("button", {
				name: "画像の注記: 2019年のラベル画像です",
			}),
		);
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
		// 手元写真なので overlay は出さない
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

// 画像の切替と代表選択(#568)。サムネイルのタップで関連写真のダイアログを開き、
// 送りで切り替えたうえで「代表画像として選択」すると、その写真がカードの
// サムネイルになる(登録ペイロードは変えない)。
describe("ImportCandidateCard の画像切替と代表選択", () => {
	const PREVIEWS = ["blob:photo-0", "blob:photo-1", "blob:photo-2"];

	/** サムネイルのタップでダイアログを開く */
	async function openDialog(name: string | RegExp) {
		fireEvent.click(screen.getByRole("button", { name }));
		return screen.findByRole("dialog");
	}

	function dialogSrc(): string | null {
		return (
			screen.queryByRole("dialog")?.querySelector("img")?.getAttribute("src") ??
			null
		);
	}

	it("タップで関連写真のダイアログが開き、送りで切り替えられる", async () => {
		renderCard(
			{ photoKind: "bottle", photoIndexes: [0, 2], bottlePhotoIndex: 2 },
			PREVIEWS,
		);
		// 一覧は bottle → 関連順。サムネイル(自動選択の photo-2)から開く
		const dialog = await openDialog("Baroloの写真を拡大");
		expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
			"blob:photo-2",
		);
		expect(screen.getByText("1 / 2")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "次の写真" }));
		expect(dialogSrc()).toBe("blob:photo-0");
		expect(screen.getByText("2 / 2")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "前の写真" }));
		expect(dialogSrc()).toBe("blob:photo-2");
	});

	it("代表画像として選択すると onChange に載る", async () => {
		const patches: Partial<ImportCardState>[] = [];
		renderCard(
			{ photoKind: "bottle", photoIndexes: [0, 2], bottlePhotoIndex: 2 },
			PREVIEWS,
			(patch) => patches.push(patch),
		);
		await openDialog("Baroloの写真を拡大");
		fireEvent.click(screen.getByRole("button", { name: "次の写真" }));
		expect(dialogSrc()).toBe("blob:photo-0");

		fireEvent.click(screen.getByRole("button", { name: "代表画像として選択" }));
		expect(patches).toEqual([
			{ primaryPhoto: { kind: "preview", previewIndex: 0 } },
		]);
	});

	it("代表に選んだ写真がサムネイルになり、ダイアログでは設定中になる", async () => {
		const patches: Partial<ImportCardState>[] = [];
		const { card, rerender } = renderCard(
			{ photoKind: "bottle", photoIndexes: [0, 2], bottlePhotoIndex: 2 },
			PREVIEWS,
			(patch) => patches.push(patch),
		);
		rerender(
			<ImportCandidateCard
				card={{
					...card,
					primaryPhoto: { kind: "preview", previewIndex: 0 },
				}}
				photoPreviews={PREVIEWS}
				onChange={(patch) => patches.push(patch)}
				onChangeValues={() => {}}
			/>,
		);
		// サムネイルが上書きの写真に変わる
		expect(
			screen
				.getByRole("button", { name: "Baroloの写真を拡大" })
				.querySelector("img")
				?.getAttribute("src"),
		).toBe("blob:photo-0");

		// ダイアログは代表の位置から開き、ボタンは設定中になる
		await openDialog("Baroloの写真を拡大");
		expect(dialogSrc()).toBe("blob:photo-0");
		const selected = screen.getByRole("button", {
			name: "代表画像に設定中",
		});
		expect(selected.hasAttribute("disabled")).toBe(true);
		expect(
			screen.queryByRole("button", { name: "代表画像として選択" }),
		).toBeNull();
	});

	it("web 由来カードは web → 手元の順で、代表選択で手元へ切り替えられる", async () => {
		const patches: Partial<ImportCardState>[] = [];
		renderCard(
			{
				photoKind: "web",
				imageUrl: "https://example.com/barolo.jpg",
				photoIndexes: [1],
			},
			PREVIEWS,
			(patch) => patches.push(patch),
		);
		await openDialog("Baroloの写真(WEB画像)を拡大");
		expect(dialogSrc()).toBe("https://example.com/barolo.jpg");
		expect(screen.getByText("1 / 2")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "次の写真" }));
		expect(dialogSrc()).toBe("blob:photo-1");

		fireEvent.click(screen.getByRole("button", { name: "代表画像として選択" }));
		expect(patches).toEqual([
			{ primaryPhoto: { kind: "preview", previewIndex: 1 } },
		]);
	});
});
