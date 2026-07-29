import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	isNearBottom,
	STICK_TO_BOTTOM_THRESHOLD_PX,
	useStickToBottom,
} from "./use-stick-to-bottom";

// 会話ログの追従(#242)。jsdom はレイアウトを持たず scrollHeight / clientHeight が常に 0 に
// なるため、テスト用のハーネスで実寸を差し込んでフックの配線を検証する。
// 「新着で最下部へ寄る」「ユーザが上を読んでいる間は引き戻さない」の2つが要件。

afterEach(cleanup);

const VIEWPORT = 200;

/** contentSignal を渡すとログが伸びる想定のハーネス */
function Harness({ signal, height }: { signal: string; height: number }) {
	const log = useStickToBottom<HTMLDivElement>(signal);
	return (
		<div ref={log.ref} onScroll={log.onScroll} data-testid="log">
			{signal}
			{height}
		</div>
	);
}

/** jsdom の要素に実寸(レイアウト結果)を差し込む */
function setGeometry(el: HTMLElement, scrollHeight: number): void {
	Object.defineProperty(el, "scrollHeight", {
		value: scrollHeight,
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight", {
		value: VIEWPORT,
		configurable: true,
	});
}

describe("isNearBottom", () => {
	it("最下部ちょうどは追従対象", () => {
		expect(
			isNearBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }),
		).toBe(true);
	});

	it("しきい値以内のズレは追従対象(端数スクロールで外れない)", () => {
		expect(
			isNearBottom({
				scrollTop: 800 - STICK_TO_BOTTOM_THRESHOLD_PX,
				scrollHeight: 1000,
				clientHeight: 200,
			}),
		).toBe(true);
	});

	it("しきい値を超えて上を見ているときは追従しない", () => {
		expect(
			isNearBottom({
				scrollTop: 800 - STICK_TO_BOTTOM_THRESHOLD_PX - 1,
				scrollHeight: 1000,
				clientHeight: 200,
			}),
		).toBe(false);
	});
});

describe("useStickToBottom", () => {
	it("新着で最下部までスクロールする", () => {
		const { getByTestId, rerender } = render(
			<Harness signal="a" height={400} />,
		);
		const el = getByTestId("log");
		setGeometry(el, 400);
		el.scrollTop = 200; // 最下部(400-200)

		// 新着でログが伸びる
		setGeometry(el, 600);
		rerender(<Harness signal="b" height={600} />);

		expect(el.scrollTop).toBe(600);
	});

	it("ユーザが上を読んでいる間は引き戻さない", () => {
		const { getByTestId, rerender } = render(
			<Harness signal="a" height={400} />,
		);
		const el = getByTestId("log");
		setGeometry(el, 400);

		// ユーザが上へスクロール(最下部から十分離れる)
		el.scrollTop = 0;
		fireEvent.scroll(el);

		setGeometry(el, 600);
		rerender(<Harness signal="b" height={600} />);

		expect(el.scrollTop).toBe(0);
	});

	it("最下部付近まで戻したら追従が再開する", () => {
		const { getByTestId, rerender } = render(
			<Harness signal="a" height={400} />,
		);
		const el = getByTestId("log");
		setGeometry(el, 400);

		el.scrollTop = 0;
		fireEvent.scroll(el);
		el.scrollTop = 200; // 最下部へ戻す
		fireEvent.scroll(el);

		setGeometry(el, 600);
		rerender(<Harness signal="b" height={600} />);

		expect(el.scrollTop).toBe(600);
	});

	it("同じ signal の再レンダーではスクロールを動かさない", () => {
		const { getByTestId, rerender } = render(
			<Harness signal="a" height={400} />,
		);
		const el = getByTestId("log");
		setGeometry(el, 400);
		el.scrollTop = 120;

		rerender(<Harness signal="a" height={400} />);

		expect(el.scrollTop).toBe(120);
	});
});
