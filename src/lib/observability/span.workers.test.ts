import { describe, expect, it } from "vitest";
import { withSpan } from "./span";

// スパンの中身(記録された属性)は実行中のコードからは読めない——`Span` が公開している
// のは `isTraced` と書き込み系だけで、workerd にスパンを取り出す口は無い。したがって
// ここで固定するのは**「計装が呼び出し側の挙動を変えないこと」**に絞る。属性が実際に
// 乗っているかはデプロイ後に `bun run traces` で確認する(docs/deployment.md)。
//
// これは形だけのテストではない。withSpan はクレジットを消費するAI推論・キューの
// コンシューマ・MCPツールという「失敗すると実害が出る」経路を包むので、戻り値の素通しと
// 例外の伝播が崩れると、その全部が壊れる。

describe("withSpan", () => {
	it("同期の戻り値をそのまま返す", () => {
		const result = withSpan(
			"test_span",
			{ "wine.test.kind": "sync" },
			() => 42,
		);
		expect(result).toBe(42);
	});

	it("非同期の戻り値をそのまま返す", async () => {
		const result = await withSpan(
			"test_span",
			{ "wine.test.kind": "async" },
			async () => "done",
		);
		expect(result).toBe("done");
	});

	it("同期の例外をそのまま伝播する", () => {
		expect(() =>
			withSpan("test_span", {}, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
	});

	it("非同期の例外をそのまま伝播する", async () => {
		await expect(
			withSpan("test_span", {}, async () => {
				throw new Error("async boom");
			}),
		).rejects.toThrow("async boom");
	});

	it("undefined の属性を渡しても失敗しない", () => {
		const result = withSpan(
			"test_span",
			{ "wine.test.present": "yes", "wine.test.absent": undefined },
			() => "ok",
		);
		expect(result).toBe("ok");
	});

	it("実行中に判明した属性を span.set() で足せる", async () => {
		const result = await withSpan("test_span", {}, async (span) => {
			span.set({ "wine.test.outcome": "ok", "wine.test.count": 3 });
			span.set({ "wine.test.flag": true, "wine.test.skipped": undefined });
			return "set";
		});
		expect(result).toBe("set");
	});

	it("例外を投げる経路でも set() 済みの属性で失敗しない", async () => {
		await expect(
			withSpan("test_span", {}, async (span) => {
				span.set({ "wine.test.outcome": "failed" });
				throw new Error("after set");
			}),
		).rejects.toThrow("after set");
	});
});
