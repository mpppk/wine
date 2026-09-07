import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WinePhotoGallery, ZoomablePhoto } from "./WinePhotoGallery";

// 閲覧画面の写真の規約: 並んでいるのはサムネイル、タップで開くのは原寸。
// キャッシュバスタ(?v=updatedAt)は一覧・編集画面と同じく必ず付ける。

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());

const PROPS = {
	name: "テストワイン",
	photoUrls: ["/api/images/a.jpg", "/api/images/b.jpg"],
	thumbUrls: ["/api/images/a-thumb.jpg", "/api/images/b-thumb.jpg"],
	version: 42,
};

/** 拡大ダイアログを開く(サムネイルのタップ) */
async function openLightbox(name: string) {
	fireEvent.click(screen.getByRole("button", { name }));
	return screen.findByRole("dialog");
}

/** ライトボックス内の画像の src。開いていなければ null */
function lightboxSrc(): string | null {
	const img = screen.queryByRole("dialog")?.querySelector("img");
	return img?.getAttribute("src") ?? null;
}

describe("WinePhotoGallery", () => {
	it("一覧はサムネイルを出す", () => {
		render(<WinePhotoGallery {...PROPS} />);
		const thumbs = screen
			.getAllByRole("button")
			.map((b) => b.querySelector("img")?.getAttribute("src"));
		expect(thumbs).toEqual([
			"/api/images/a-thumb.jpg?v=42",
			"/api/images/b-thumb.jpg?v=42",
		]);
	});

	it("写真をタップすると原寸で拡大表示する", async () => {
		render(<WinePhotoGallery {...PROPS} />);
		expect(screen.queryByRole("dialog")).toBeNull();

		const dialog = await openLightbox("テストワインの写真2を拡大");
		const img = dialog.querySelector("img");
		expect(img?.getAttribute("src")).toBe("/api/images/b.jpg?v=42");
		expect(img?.getAttribute("alt")).toBe("テストワインの写真2");
	});

	it("拡大表示から次の写真へ送れる(端では巻き戻る)", async () => {
		render(<WinePhotoGallery {...PROPS} />);
		await openLightbox("テストワインの写真1を拡大");

		fireEvent.click(screen.getByRole("button", { name: "次の写真" }));
		expect(lightboxSrc()).toBe("/api/images/b.jpg?v=42");

		fireEvent.click(screen.getByRole("button", { name: "次の写真" }));
		expect(lightboxSrc()).toBe("/api/images/a.jpg?v=42");
	});

	it("写真が1枚だけなら送りのボタンを出さない", async () => {
		render(
			<WinePhotoGallery
				{...PROPS}
				photoUrls={["/api/images/a.jpg"]}
				thumbUrls={["/api/images/a-thumb.jpg"]}
			/>,
		);
		await openLightbox("テストワインの写真1を拡大");
		expect(screen.queryByRole("button", { name: "次の写真" })).toBeNull();
	});

	it("写真が無ければ拡大できる画像を出さない", () => {
		render(<WinePhotoGallery {...PROPS} photoUrls={[]} thumbUrls={[]} />);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	it("由来の指定が無ければ overlay を出さない(保存済み表示の既定)", () => {
		const { container } = render(<WinePhotoGallery {...PROPS} />);
		expect(container.textContent).not.toContain("WEB");
	});
});

describe("WinePhotoGallery の WEB 由来表示(IMPL-4)", () => {
	it("web の写真にだけ左上の overlay を出す", () => {
		render(
			<WinePhotoGallery {...PROPS} photoKinds={["bottle", "web"] as const} />,
		);
		const buttons = screen.getAllByRole("button");
		expect(buttons[0]?.textContent).not.toContain("WEB");
		expect(buttons[1]?.textContent).toContain("WEB");
	});

	it("由来をボタンの名前と拡大の alt に含める", async () => {
		render(
			<WinePhotoGallery {...PROPS} photoKinds={["bottle", "web"] as const} />,
		);
		expect(
			screen.getByRole("button", { name: "テストワインの写真1を拡大" }),
		).toBeTruthy();
		const dialog = await openLightbox("テストワインの写真2(WEB画像)を拡大");
		expect(dialog.querySelector("img")?.getAttribute("alt")).toBe(
			"テストワインの写真2(WEB画像)",
		);
	});
});

describe("ZoomablePhoto", () => {
	it("タップで同じ画像を拡大表示する", async () => {
		render(
			<ZoomablePhoto src="/api/images/s.jpg?v=7" alt="見かけたときの写真" />,
		);
		await openLightbox("見かけたときの写真を拡大");
		expect(lightboxSrc()).toBe("/api/images/s.jpg?v=7");
	});

	it("WEB由来なら overlay を出し、由来を名前に含める(IMPL-4)", async () => {
		render(
			<ZoomablePhoto
				src="https://example.com/a.jpg"
				alt="バローロの写真"
				isWebPhoto
			/>,
		);
		const button = screen.getByRole("button", {
			name: "バローロの写真(WEB画像)を拡大",
		});
		expect(button.textContent).toContain("WEB");
		await openLightbox("バローロの写真(WEB画像)を拡大");
		expect(lightboxSrc()).toBe("https://example.com/a.jpg");
	});

	it("手元写真には overlay を出さない", () => {
		const { container } = render(
			<ZoomablePhoto src="/api/images/s.jpg?v=7" alt="見かけたときの写真" />,
		);
		expect(container.textContent).not.toContain("WEB");
	});
});
