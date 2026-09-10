import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Aop } from "#/lib/wine/types";

// server function / router / 課金状態は Cloudflare 依存を引き込むためモックする。
// ルーターは共有スタブを使う(定型を直接書くと jscpd の重複検出で落ちる)。
const getNextQuestions = vi.fn();
vi.mock("#/server/quiz", () => ({
	getNextQuestions: (...args: unknown[]) => getNextQuestions(...args),
	recordAnswer: vi.fn(),
	revertAnswer: vi.fn(),
}));
vi.mock("@tanstack/react-router", async () => {
	const stub = await import("#/components/router-test-stub");
	return { Link: stub.StubLink, useRouter: stub.stubUseRouter };
});
vi.mock("#/lib/billing/use-billing", () => ({ useShowAds: () => false }));

const { MapQuizDialog } = await import("./MapQuizDialog");

afterEach(() => cleanup());

const AOP = { id: "test-village", nameJa: "テスト村" } as Aop;

/**
 * 詳細パネルのボタンが「復習」を名乗るときは、開いた先も1周目から復習
 * (正解済みも出題)でなければならない。既定のまま開くと「すべて正解済みです」の
 * 完了画面が挟まり、再チャレンジに一手余計にかかる。
 */
describe("MapQuizDialog の復習モード", () => {
	beforeEach(() => {
		getNextQuestions.mockReset();
		getNextQuestions.mockResolvedValue({
			questions: [],
			remaining: 0,
			total: 0,
		});
	});

	it("initialIncludeSolved を渡すと1周目から正解済みも出題する", async () => {
		render(
			<MapQuizDialog
				open
				onOpenChange={() => {}}
				regionId="bourgogne"
				regionNameJa="ブルゴーニュ"
				scopeAop={AOP}
				isAuthenticated
				initialIncludeSolved
			/>,
		);
		await waitFor(() => expect(getNextQuestions).toHaveBeenCalled());
		expect(getNextQuestions).toHaveBeenCalledWith({
			data: expect.objectContaining({
				scopeAopId: "test-village",
				includeSolved: true,
			}),
		});
		expect(screen.getByText("テスト村のクイズ")).toBeTruthy();
	});

	it("既定では未正解のみを出題する", async () => {
		render(
			<MapQuizDialog
				open
				onOpenChange={() => {}}
				regionId="bourgogne"
				regionNameJa="ブルゴーニュ"
				scopeAop={AOP}
				isAuthenticated
			/>,
		);
		await waitFor(() => expect(getNextQuestions).toHaveBeenCalled());
		expect(getNextQuestions).toHaveBeenCalledWith({
			data: expect.objectContaining({ includeSolved: false }),
		});
	});
});
