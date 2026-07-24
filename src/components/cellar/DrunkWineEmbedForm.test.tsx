import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DrunkWinePatch } from "#/lib/drunk-wine/fields";
import type { ReceivedDrunkWineEntry } from "#/lib/mcp-app/entry";
import { DrunkWineEmbedForm } from "./DrunkWineEmbedForm";

// MCP App のフォームは Web版と同じ DrunkWineFields で描画され、パッチ生成も
// collectDrunkWinePatch を直接使う。以前は apps.ts のテンプレート文字列内 JS が
// 同じことを別実装しており substring テストしか書けなかった(#155/#189)。
// ここでは「描画 → 編集 → 保存パッチ」を実物で固定する。

const BASE = "https://wine.example";

const ENTRY: ReceivedDrunkWineEntry = {
	id: "entry-1",
	name: "Chablis",
	drank_on: "2020-01-02",
	rating: 3,
	vintage: 2018,
	producer: "Dauvissat",
	price: 3000,
	aop_id: "chablis",
	region_id: "bourgogne",
	grape_variety_ids: ["chardonnay"],
	memo: "good",
	photo_urls: [`${BASE}/api/images/wines/u1/entry-1/p1.jpg?v=1`],
};

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());

function renderForm(overrides: Partial<ReceivedDrunkWineEntry> = {}) {
	const onSave = vi.fn<(patch: DrunkWinePatch) => void>();
	const onNoChanges = vi.fn();
	render(
		<DrunkWineEmbedForm
			entry={{ ...ENTRY, ...overrides }}
			baseUrl={BASE}
			onSave={onSave}
			onNoChanges={onNoChanges}
		/>,
	);
	return { onSave, onNoChanges };
}

const field = (label: string | RegExp): HTMLInputElement =>
	screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () =>
	screen.getByRole("button", { name: /^保存/ }) as HTMLButtonElement;
const save = () => fireEvent.click(saveButton());

describe("DrunkWineEmbedForm", () => {
	it("受け取ったエントリの値を全フィールドに反映する", () => {
		renderForm();
		expect(field(/名前/).value).toBe("Chablis");
		expect(field("飲んだ日").value).toBe("2020-01-02");
		expect(field("ヴィンテージ").value).toBe("2018");
		expect(field("生産者").value).toBe("Dauvissat");
		expect(field(/価格/).value).toBe("3000");
		expect(field("メモ").value).toBe("good");
		// 評価(星)は押下状態で表現される
		expect(
			screen.getByRole("button", { name: "星3" }).getAttribute("aria-pressed"),
		).toBe("true");
		// 選択済みのAOP・品種はボタンのラベルに出る
		expect(screen.getByText("シャブリ")).toBeTruthy();
		expect(screen.getByText("1品種を選択中")).toBeTruthy();
	});

	it("photo_urls の全枚数を描画する(代表1枚だけにしない)", () => {
		renderForm({
			photo_urls: [`${BASE}/api/images/a.jpg`, `${BASE}/api/images/b.jpg`],
		});
		expect(screen.getAllByRole("img")).toHaveLength(2);
	});

	it("自オリジン以外の写真URLは描画しない(前方一致の偽装も弾く)", () => {
		renderForm({
			photo_urls: [
				"https://wine.example.evil.test/api/images/a.jpg",
				"javascript:alert(1)",
				`${BASE}/api/images/ok.jpg`,
			],
		});
		const images = screen.getAllByRole("img");
		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe(`${BASE}/api/images/ok.jpg`);
	});

	it("photo_urls が無ければ後方互換の photo_url を使う", () => {
		renderForm({ photo_urls: [], photo_url: `${BASE}/api/images/legacy.jpg` });
		expect(screen.getAllByRole("img")).toHaveLength(1);
	});

	it("変更したフィールドだけを snake_case のパッチで保存する", () => {
		const { onSave } = renderForm();
		fireEvent.change(field(/名前/), { target: { value: "Chablis 1er Cru" } });
		fireEvent.change(field("ヴィンテージ"), { target: { value: "2019" } });
		save();
		expect(onSave).toHaveBeenCalledWith({
			name: "Chablis 1er Cru",
			vintage: 2019,
		});
	});

	it("空欄にした項目は null(クリア)として送る", () => {
		const { onSave } = renderForm();
		fireEvent.change(field("メモ"), { target: { value: "" } });
		fireEvent.change(field(/価格/), { target: { value: "" } });
		save();
		expect(onSave).toHaveBeenCalledWith({ memo: null, price: null });
	});

	it("評価の解除も null として送る", () => {
		const { onSave } = renderForm();
		fireEvent.click(screen.getByRole("button", { name: "星3" }));
		save();
		expect(onSave).toHaveBeenCalledWith({ rating: null });
	});

	it("変更が無ければ保存せず onNoChanges を呼ぶ", () => {
		const { onSave, onNoChanges } = renderForm();
		save();
		expect(onSave).not.toHaveBeenCalled();
		expect(onNoChanges).toHaveBeenCalled();
	});

	it("名前が空だと保存できない(クリア不可の必須項目)", () => {
		renderForm();
		fireEvent.change(field(/名前/), { target: { value: " " } });
		expect(saveButton().disabled).toBe(true);
	});

	it("保存中はボタンを無効にし、状態メッセージを表示する", () => {
		render(
			<DrunkWineEmbedForm
				entry={ENTRY}
				baseUrl={BASE}
				onSave={vi.fn()}
				saving
				status={{ text: "保存中…", kind: "ok" }}
			/>,
		);
		expect(saveButton().disabled).toBe(true);
		expect(screen.getByText("保存中…")).toBeTruthy();
	});

	it("型が壊れたエントリでも描画できる(ホストからの外部入力)", () => {
		renderForm({
			rating: "3" as unknown as number,
			grape_variety_ids: "chardonnay" as unknown as string[],
			memo: null,
		});
		expect(field("メモ").value).toBe("");
		// 配列でない grape_variety_ids は「未選択」に倒す
		expect(screen.queryByText(/品種を選択中/)).toBeNull();
	});
});
