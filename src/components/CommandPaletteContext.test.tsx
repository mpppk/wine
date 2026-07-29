import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CommandPaletteProvider,
	useCommandPalette,
	usePaletteCommand,
} from "./CommandPaletteContext";

// ページ固有コマンド(地図の「AIに質問」)の登録レジストリ。ページ側にボタンを
// 置かずパレット経由で呼ぶ形にしたため、ここが壊れると起動導線が丸ごと消える。

afterEach(cleanup);

function wrapper({ children }: { children: ReactNode }) {
	return <CommandPaletteProvider>{children}</CommandPaletteProvider>;
}

describe("usePaletteCommand", () => {
	it("マウント中だけコマンドがパレットに載る", () => {
		const commands: string[][] = [];

		function Page() {
			usePaletteCommand({
				id: "map.ask-ai",
				label: "AIに質問",
				run: () => {},
			});
			return null;
		}

		function Palette() {
			const { pageCommands } = useCommandPalette();
			commands.push(pageCommands.map((c) => c.id));
			return null;
		}

		function App({ showPage }: { showPage: boolean }) {
			return (
				<CommandPaletteProvider>
					{showPage && <Page />}
					<Palette />
				</CommandPaletteProvider>
			);
		}

		const { rerender } = render(<App showPage />);
		expect(commands.at(-1)).toEqual(["map.ask-ai"]);

		rerender(<App showPage={false} />);
		expect(commands.at(-1)).toEqual([]);
	});

	it("再レンダーでは登録し直さない(パレットの並びを揺らさない)", () => {
		const { result, rerender } = renderHook(
			() => {
				const [n, setN] = useState(0);
				usePaletteCommand({
					id: "map.ask-ai",
					label: "AIに質問",
					keywords: ["ai", "質問"],
					run: () => {},
				});
				const { pageCommands } = useCommandPalette();
				return { setN, n, pageCommands };
			},
			{ wrapper },
		);

		const first = result.current.pageCommands[0];
		act(() => result.current.setN(1));
		rerender();

		// 同一オブジェクトのまま = 登録・解除が走っていない(二重登録もしない)
		expect(result.current.pageCommands).toHaveLength(1);
		expect(result.current.pageCommands[0]).toBe(first);
	});

	it("run は登録時ではなく実行時の最新クロージャを呼ぶ", () => {
		const spy = vi.fn();

		const { result } = renderHook(
			() => {
				const [n, setN] = useState(0);
				usePaletteCommand({
					id: "map.ask-ai",
					label: "AIに質問",
					run: () => spy(n),
				});
				const { pageCommands } = useCommandPalette();
				return { setN, pageCommands };
			},
			{ wrapper },
		);

		act(() => result.current.setN(3));
		act(() => {
			void result.current.pageCommands[0]?.run();
		});

		expect(spy).toHaveBeenCalledWith(3);
	});

	it("null を渡す間は登録されない", () => {
		const { result } = renderHook(
			() => {
				usePaletteCommand(null);
				return useCommandPalette();
			},
			{ wrapper },
		);

		expect(result.current.pageCommands).toEqual([]);
	});
});
