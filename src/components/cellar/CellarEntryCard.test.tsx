import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";

// ルーターは Cloudflare 依存を引き込むため、Link と useRouter だけのスタブにする
// (ImportBatchDetail.test.tsx と同じ流儀)。server fn も呼ばないのでスタブにする。
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
	useRouter: () => ({ invalidate: vi.fn() }),
}));
vi.mock("#/server/drunk-wine", () => ({ markWineDrunk: vi.fn() }));

const { EntryCard } = await import("./CellarEntryCard");

afterEach(() => cleanup());

const BASE: DrunkWineEntry = {
	id: "e1",
	name: "テストワイン",
	status: "finished",
	lastDrankOn: null,
	tastingCount: 0,
	lastSeenOn: null,
	sightingCount: 0,
	aopId: null,
	aopNameJa: null,
	regionId: null,
	countryId: null,
	lastRating: null,
	lastMemo: null,
	vintage: null,
	grapeVarietyIds: [],
	producer: null,
	note: null,
	price: null,
	referenceLinks: [],
	prices: [],
	photoUrls: [],
	thumbUrls: [],
	photoKinds: [],
	createdAt: 0,
	updatedAt: 0,
};

function renderCard(entry: DrunkWineEntry) {
	const client = new QueryClient();
	render(
		createElement(
			QueryClientProvider,
			{ client },
			createElement(EntryCard, {
				entry,
				selectMode: false,
				selected: false,
				onToggleSelect: () => {},
			}),
		),
	);
}

// 一覧カードの表示規約(Issue #597): 生産者を出し、ヴィンテージを出さない
describe("EntryCard", () => {
	it("生産者を表示し、ヴィンテージを表示しない", () => {
		renderCard({ ...BASE, vintage: 2020, producer: "ドメーヌ・ルフレーヴ" });
		expect(screen.getByText("ドメーヌ・ルフレーヴ")).not.toBeNull();
		expect(screen.queryByText("2020年")).toBeNull();
	});

	it("生産者が無いときは生産者行もヴィンテージ行も出さない", () => {
		const { container } = render(
			createElement(
				QueryClientProvider,
				{ client: new QueryClient() },
				createElement(EntryCard, {
					entry: { ...BASE, vintage: 2020 },
					selectMode: false,
					selected: false,
					onToggleSelect: () => {},
				}),
			),
		);
		expect(container.textContent).not.toContain("2020");
	});
});
