import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { makeDrunkWineEntry } from "./drunk-wine-entry-fixture";

// ルーターは Cloudflare 依存を引き込むため、共有スタブに差し替える
// (router-test-stub。定型を直接書くと jscpd の重複検出で落ちる)。
// server fn も呼ばないのでスタブにする。
vi.mock("@tanstack/react-router", async () => {
	const stub = await import("#/components/router-test-stub");
	return { Link: stub.StubLink, useRouter: stub.stubUseRouter };
});
vi.mock("#/server/drunk-wine", () => ({ markWineDrunk: vi.fn() }));

const { EntryCard } = await import("./CellarEntryCard");

afterEach(() => cleanup());

function renderCard(entry: DrunkWineEntry) {
	return render(
		createElement(
			QueryClientProvider,
			{ client: new QueryClient() },
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
		renderCard(
			makeDrunkWineEntry({ vintage: 2020, producer: "ドメーヌ・ルフレーヴ" }),
		);
		expect(screen.getByText("ドメーヌ・ルフレーヴ")).not.toBeNull();
		expect(screen.queryByText("2020年")).toBeNull();
	});

	it("生産者が無いときは生産者行もヴィンテージ行も出さない", () => {
		const { container } = renderCard(makeDrunkWineEntry({ vintage: 2020 }));
		expect(container.textContent).not.toContain("2020");
	});
});
