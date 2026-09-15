import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duplicatePlaceNameMessage } from "#/lib/place/place";
import type { PlaceEntry } from "#/lib/services/place-service";
import { EncounterFields } from "./EncounterFields";
import {
	EMPTY_ENCOUNTER_DRAFT,
	NEW_PLACE_VALUE,
	type WineEncounterDraft,
} from "./encounter-payload";

// 体験記録の入力欄の規約: 「このとき飲んだ」トグルが先頭で、ON のときだけ
// 評価が出る。場所はどの経路でもその場で作れる(新規登録・編集画面の双方)。
// 作れるぶん、同名は作れないことを保存前に伝える必要がある——サーバは
// prepareNewPlace で 409 を返すので、押してから気付くと入力をやり直させることになる。

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());

const PLACES: PlaceEntry[] = [
	{
		id: "p1",
		name: "エノテカ 渋谷",
		kind: "shop",
		memo: null,
		createdAt: 0,
		updatedAt: 0,
	},
];

function setup(draft: Partial<WineEncounterDraft> = {}, places = PLACES) {
	render(
		<EncounterFields
			value={{ ...EMPTY_ENCOUNTER_DRAFT, ...draft }}
			onChange={vi.fn()}
			places={places}
			idPrefix="e"
		/>,
	);
}

describe("EncounterFields の飲んだトグルと評価", () => {
	it("トグルOFFでは評価を出さない", () => {
		setup({ drank: false });
		expect(screen.getByText("このとき飲んだ")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "星1" })).toBeNull();
	});

	it("トグルONで評価が出る", () => {
		setup({ drank: true });
		expect(screen.getByRole("button", { name: "星1" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "星5" })).toBeTruthy();
	});
});

describe("EncounterFields の場所", () => {
	it("場所が1件も無くても選択は無効にならない(新規作成へ進める)", () => {
		setup({}, []);
		expect(screen.getByLabelText("場所").hasAttribute("disabled")).toBe(false);
	});

	it("新規作成を選ぶと名前の入力が出る", () => {
		setup({ placeId: NEW_PLACE_VALUE });
		expect(screen.getByLabelText("新しい場所の名前")).toBeTruthy();
	});

	it("既存と同じ名前を入力したら保存前に警告する", () => {
		setup({ placeId: NEW_PLACE_VALUE, newPlaceName: "  エノテカ 渋谷  " });
		// 前後の空白は送信時に落ちるので、警告も trim 後の名前で判定する
		expect(
			screen.getByText(duplicatePlaceNameMessage("エノテカ 渋谷")),
		).toBeTruthy();
		expect(
			screen.getByLabelText("新しい場所の名前").getAttribute("aria-invalid"),
		).toBe("true");
	});

	it("別の名前なら警告しない", () => {
		setup({ placeId: NEW_PLACE_VALUE, newPlaceName: "エノテカ 銀座" });
		expect(screen.queryByText(/既に登録されています/)).toBeNull();
	});
});
