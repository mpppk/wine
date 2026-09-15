import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duplicatePlaceNameMessage } from "#/lib/place/place";
import type { PlaceEntry } from "#/lib/services/place-service";
import {
	EMPTY_SIGHTING_DRAFT,
	NEW_PLACE_VALUE,
	SightingFields,
	type WineSightingDraft,
} from "./SightingFields";

// 目撃記録の入力欄の規約: 場所はどの経路でもその場で作れる(新規登録・編集画面の
// 双方)。作れるぶん、同名は作れないことを保存前に伝える必要がある——サーバは
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

function setup(draft: Partial<WineSightingDraft> = {}, places = PLACES) {
	render(
		<SightingFields
			value={{ ...EMPTY_SIGHTING_DRAFT, ...draft }}
			onChange={vi.fn()}
			places={places}
			idPrefix="s"
		/>,
	);
}

describe("SightingFields の場所", () => {
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
