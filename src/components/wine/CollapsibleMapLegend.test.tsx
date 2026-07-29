import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CellarStatusLegend } from "#/components/cellar/CellarStatusLegend";
import { MAP_LEGEND_KEYS } from "#/lib/map-legend";
import { CollapsibleMapLegend } from "./CollapsibleMapLegend";
import { MapProgressLegend } from "./ProgressLegend";

// 地図の凡例は AOP名のラベルに重なるため折りたためる。閉じた状態は端末に残り、
// 次回以降は最初から小さなチップで出る、という約束の回帰テスト。

// vitest の globals は無効なので、RTL の自動クリーンアップは働かない
afterEach(() => cleanup());
beforeEach(() => window.localStorage.clear());

const KEY = MAP_LEGEND_KEYS.progress;

function renderLegend() {
	return render(
		<CollapsibleMapLegend
			storageKey={KEY}
			title="テスト凡例"
			collapsedPreview={<span>preview</span>}
		>
			<span>中身</span>
		</CollapsibleMapLegend>,
	);
}

const body = () => screen.queryByText("中身");
const collapsedButton = () =>
	screen.queryByRole("button", { name: "テスト凡例の凡例を表示" });

describe("CollapsibleMapLegend", () => {
	it("初回は展開して表示される", async () => {
		renderLegend();
		await waitFor(() => expect(body()).not.toBeNull());
		expect(collapsedButton()).toBeNull();
	});

	it("閉じるとプレビューだけのボタンに縮み、状態が永続化される", async () => {
		renderLegend();
		await waitFor(() => expect(body()).not.toBeNull());

		fireEvent.click(
			screen.getByRole("button", { name: "テスト凡例の凡例を閉じる" }),
		);

		expect(body()).toBeNull();
		expect(collapsedButton()).not.toBeNull();
		expect(window.localStorage.getItem(KEY)).toBe("1");
	});

	it("閉じた記録があるときは最初からチップで出る(展開状態を一瞬も見せない)", async () => {
		window.localStorage.setItem(KEY, "1");
		renderLegend();

		await waitFor(() => expect(collapsedButton()).not.toBeNull());
		expect(body()).toBeNull();
	});

	it("チップを押すと再び展開し、記録も消える", async () => {
		window.localStorage.setItem(KEY, "1");
		renderLegend();
		await waitFor(() => expect(collapsedButton()).not.toBeNull());

		fireEvent.click(
			screen.getByRole("button", { name: "テスト凡例の凡例を表示" }),
		);

		expect(body()).not.toBeNull();
		expect(window.localStorage.getItem(KEY)).toBeNull();
	});
});

describe("地図ごとの凡例", () => {
	it("AOP地図の進捗凡例を閉じても、マイセラー地図の凡例は開いたまま(キーが別)", async () => {
		const progress = render(<MapProgressLegend />);
		await waitFor(() =>
			expect(screen.queryByText("クイズ正解率")).not.toBeNull(),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "クイズ正解率の凡例を閉じる" }),
		);
		expect(window.localStorage.getItem(MAP_LEGEND_KEYS.progress)).toBe("1");
		progress.unmount();

		render(<CellarStatusLegend showMixedNote={false} />);
		await waitFor(() => expect(screen.queryByText("所有状態")).not.toBeNull());
		expect(
			window.localStorage.getItem(MAP_LEGEND_KEYS.cellarStatus),
		).toBeNull();
	});

	it("マイセラー地図の凡例は混在注記も畳んで開閉できる", async () => {
		render(<CellarStatusLegend showMixedNote />);
		await waitFor(() =>
			expect(screen.queryByText("セラーにある")).not.toBeNull(),
		);
		expect(screen.queryByText(/優先して表示します/)).not.toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "所有状態の凡例を閉じる" }),
		);

		expect(screen.queryByText("セラーにある")).toBeNull();
		expect(screen.queryByText(/優先して表示します/)).toBeNull();
		expect(
			screen.queryByRole("button", { name: "所有状態の凡例を表示" }),
		).not.toBeNull();
	});
});
