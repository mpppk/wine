import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportBatchDetail } from "#/lib/services/drunk-wine-service";

// ルーターは Cloudflare 依存を引き込むため、Link だけのスタブにする
// (MapQuizDialog.test.tsx と同じ流儀)。遷移先の検証は href で行う。
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		params,
		...rest
	}: {
		children?: ReactNode;
		to?: string;
		params?: Record<string, string>;
	}) =>
		createElement(
			"a",
			{
				href: to?.replace(/\$(\w+)/g, (_, key) => params?.[key] ?? ""),
				...rest,
			},
			children,
		),
}));

const { ImportBatchDetailView } = await import("./ImportBatchDetail");

afterEach(() => cleanup());

const DETAIL: ImportBatchDetail = {
	id: "b1",
	placeName: "エノテカ 渋谷",
	seenOn: "2026-08-01",
	photoUrls: ["/api/images/batch-0.jpg", "/api/images/batch-1.jpg"],
	createdAt: 1_786_000_000_000,
	createdEntries: [
		{
			id: "e1",
			name: "新規のワイン",
			status: "spotted",
			vintage: 2020,
			producer: "Dauvissat",
			note: "",
			photoUrls: ["/api/images/e1.jpg"],
			thumbUrls: ["/api/images/e1-thumb.jpg"],
			photoKinds: ["bottle"],
			createdAt: 1_786_000_000_000,
			updatedAt: 1_786_000_000_000,
			sighting: {
				placeName: "エノテカ 渋谷",
				seenOn: "2026-08-01",
				price: 24000,
				memo: null,
				photoUrl: "/api/images/batch-0.jpg",
			},
		},
	],
	matchedSightings: [
		{
			id: "s1",
			entryId: "e0",
			entryName: "既存のワイン",
			placeName: null,
			seenOn: null,
			price: 9800,
			memo: null,
			photoUrl: "/api/images/batch-1.jpg",
			photoIndex: 1,
		},
	],
};

describe("ImportBatchDetailView", () => {
	it("ヘッダーに日時・場所・件数を出す", () => {
		render(<ImportBatchDetailView detail={DETAIL} />);
		expect(screen.getByText("写真2枚・新規1件・既存へ追加1件")).toBeTruthy();
		expect(
			screen.getByText("エノテカ 渋谷・2026-08-01に見かけた"),
		).toBeTruthy();
	});

	it("バッチ写真を一覧し、タップで拡大できる", async () => {
		render(<ImportBatchDetailView detail={DETAIL} />);
		fireEvent.click(
			screen.getByRole("button", { name: "一括登録の写真1を拡大" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
			"/api/images/batch-0.jpg?v=1786000000000",
		);
	});

	it("新規銘柄の値と目撃記録を出す(銘柄名は詳細へのリンク)", () => {
		const { container } = render(<ImportBatchDetailView detail={DETAIL} />);
		expect(screen.getByText("新規のワイン")).toBeTruthy();
		expect(screen.getByText("見かけた")).toBeTruthy();
		expect(screen.getByText("Dauvissat")).toBeTruthy();
		expect(screen.getByText("24,000円", { exact: false })).toBeTruthy();
		const link = screen.getByText("新規のワイン").closest("a");
		expect(link?.getAttribute("href")).toBe("/cellar/e1");
		expect(container.textContent).not.toContain("参考サイト");
	});

	it("既存追加ぶんは銘柄名と目撃記録を出す", () => {
		render(<ImportBatchDetailView detail={DETAIL} />);
		expect(screen.getByText("既存のワイン")).toBeTruthy();
		expect(screen.getByText("9,800円", { exact: false })).toBeTruthy();
		const link = screen.getByText("既存のワイン").closest("a");
		expect(link?.getAttribute("href")).toBe("/cellar/e0");
	});

	it("削除済みの銘柄はリンクにしない", () => {
		const matched = DETAIL.matchedSightings[0];
		if (!matched) throw new Error("unreachable");
		render(
			<ImportBatchDetailView
				detail={{
					...DETAIL,
					createdEntries: [],
					matchedSightings: [{ ...matched, entryName: null }],
				}}
			/>,
		);
		expect(screen.getByText("削除済みの銘柄")).toBeTruthy();
		expect(screen.getByText("削除済みの銘柄").closest("a")).toBeNull();
	});

	it("写真が無ければその旨を出し、記録が無ければ空の表示にする", () => {
		const { container } = render(
			<ImportBatchDetailView
				detail={{
					...DETAIL,
					photoUrls: [],
					createdEntries: [],
					matchedSightings: [],
				}}
			/>,
		);
		expect(screen.getByText("写真なしで登録されています。")).toBeTruthy();
		expect(
			screen.getByText("このバッチから残っている記録はありません。"),
		).toBeTruthy();
		expect(container.querySelector("img")).toBeNull();
	});
});
