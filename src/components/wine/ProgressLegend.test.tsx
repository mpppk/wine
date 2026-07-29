import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROGRESS_LEGEND_COLLAPSED_KEY } from "#/lib/wine/progress-legend";
import { MapProgressLegend } from "./ProgressLegend";

// 地図の凡例は AOP名のラベルに重なるため折りたためる。閉じた状態は端末に残り、
// 次回以降は最初からアイコン(カラースケールのみ)で出る、という約束の回帰テスト。

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());
beforeEach(() => window.localStorage.clear());

const expandedTitle = () => screen.queryByText("クイズ正解率");
const collapsedButton = () =>
	screen.queryByRole("button", { name: "クイズ正解率の凡例を表示" });

describe("MapProgressLegend", () => {
	it("初回は展開して表示される", async () => {
		render(<MapProgressLegend />);
		await waitFor(() => expect(expandedTitle()).not.toBeNull());
		expect(collapsedButton()).toBeNull();
	});

	it("閉じるとカラースケールだけのボタンに縮み、状態が永続化される", async () => {
		render(<MapProgressLegend />);
		await waitFor(() => expect(expandedTitle()).not.toBeNull());

		fireEvent.click(screen.getByRole("button", { name: "凡例を閉じる" }));

		expect(expandedTitle()).toBeNull();
		expect(collapsedButton()).not.toBeNull();
		expect(window.localStorage.getItem(PROGRESS_LEGEND_COLLAPSED_KEY)).toBe(
			"1",
		);
	});

	it("閉じた記録があるときは最初からアイコンで出る(展開状態を一瞬も見せない)", async () => {
		window.localStorage.setItem(PROGRESS_LEGEND_COLLAPSED_KEY, "1");
		render(<MapProgressLegend />);

		await waitFor(() => expect(collapsedButton()).not.toBeNull());
		expect(expandedTitle()).toBeNull();
	});

	it("アイコンを押すと再び展開し、記録も消える", async () => {
		window.localStorage.setItem(PROGRESS_LEGEND_COLLAPSED_KEY, "1");
		render(<MapProgressLegend />);
		await waitFor(() => expect(collapsedButton()).not.toBeNull());

		fireEvent.click(
			screen.getByRole("button", { name: "クイズ正解率の凡例を表示" }),
		);

		expect(expandedTitle()).not.toBeNull();
		expect(
			window.localStorage.getItem(PROGRESS_LEGEND_COLLAPSED_KEY),
		).toBeNull();
	});
});
