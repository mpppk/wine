import { globSync, readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormField, FormSection } from "./form-section";

// 見出し(Label / legend)と中身の間隔の規約を守るためのテスト。
//
// legend は fieldset のフレックス整形文脈の外に描かれるため、`fieldset` 側に
// `gap` を付けても見出しと中身の間には効かない。これを知らずに各所で
// `<fieldset className="flex flex-col gap-3">` + 本文の `-mt-2` と書いた結果、
// 「産地紐付け(任意)」の説明文が見出しに重なっていた。間隔の作り方を
// FormSection / FormField に閉じ込め、直書きの legend を禁じることで再発を防ぐ。

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());

describe("FormSection", () => {
	it("legend を fieldset の最初の子として描く(グループ名として扱われる条件)", () => {
		render(
			<FormSection title="産地紐付け(任意)">
				<input aria-label="産地" />
			</FormSection>,
		);
		const fieldset = screen.getByRole("group");
		expect(fieldset.firstElementChild?.tagName).toBe("LEGEND");
		expect(fieldset.firstElementChild?.textContent).toBe("産地紐付け(任意)");
	});

	it("見出しと本文の間隔を負のマージンで作らない", () => {
		render(
			<FormSection title="産地紐付け(任意)" description="説明文">
				<input aria-label="産地" />
			</FormSection>,
		);
		const body = screen.getByRole("group").children[1];
		const classes = body?.className.split(/\s+/) ?? [];
		// legend には gap が効かないので、間隔は本文側の margin-top で作る
		expect(classes).toContain("mt-1.5");
		expect(classes.some((c) => c.startsWith("-mt-"))).toBe(false);
		// 説明文は本文の先頭(見出しの直下)に置く
		expect(body?.firstElementChild?.textContent).toBe("説明文");
	});

	it("見出し行の操作(action)も legend の中に入れる", () => {
		render(
			<FormSection
				title="飲んだ記録"
				action={<button type="button">追加</button>}
			>
				<input aria-label="メモ" />
			</FormSection>,
		);
		const legend = screen.getByRole("group").firstElementChild;
		expect(legend?.querySelector("button")?.textContent).toBe("追加");
	});
});

describe("FormField", () => {
	it("見出しと入力欄を htmlFor で結び付ける", () => {
		render(
			<FormField label="名前" htmlFor="wine-name" required>
				<input id="wine-name" defaultValue="シャブリ" />
			</FormField>,
		);
		expect((screen.getByLabelText(/名前/) as HTMLInputElement).value).toBe(
			"シャブリ",
		);
	});

	it("補足文は入力欄の下に出す", () => {
		render(
			<FormField label="状態" htmlFor="wine-status" description="手元にない">
				<input id="wine-status" />
			</FormField>,
		);
		const field = screen.getByLabelText("状態").parentElement;
		expect(field?.lastElementChild?.textContent).toBe("手元にない");
		expect(field?.className.split(/\s+/)).toContain("gap-1.5");
	});
});

describe("見出しの間隔の単一情報源", () => {
	it("legend の直書きは form-section.tsx だけ", () => {
		const files = globSync("src/**/*.tsx").filter(
			(f) => !f.endsWith("form-section.tsx") && !f.endsWith(".test.tsx"),
		);
		const offenders = files.filter((f) =>
			readFileSync(f, "utf8").includes("<legend"),
		);
		// fieldset + legend を素で書くと gap が効かず、見出しと中身が重なる。
		// 見出し付きのグループは FormSection を使う。
		expect(offenders).toEqual([]);
	});
});
