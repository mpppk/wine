import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceivedDrunkWineEntry } from "./entry";
import {
	createHostBridge,
	findEntry,
	type HostBridge,
	RELAY_READY_MESSAGE,
	type ToolCallOutcome,
} from "./host-bridge";

const ENTRY = { id: "e1", name: "Chablis" };

function setup(timeoutMs = 1000) {
	const posted: unknown[] = [];
	const entries: ReceivedDrunkWineEntry[] = [];
	const bridge = createHostBridge({
		post: (m) => posted.push(m),
		onEntry: (e) => entries.push(e),
		timeoutMs,
	});
	return { bridge, posted, entries };
}

/** SEPモードを確定させる(ui/initialize への応答を返す)。 */
function completeSepHandshake(bridge: HostBridge) {
	bridge.start();
	bridge.handleMessage({ jsonrpc: "2.0", id: 1, result: {} });
}

function callAndCapture(bridge: HostBridge) {
	const outcomes: ToolCallOutcome[] = [];
	let timedOut = 0;
	bridge.callTool(
		"update_drunk_wine",
		{ id: "e1", name: "Chablis 1er" },
		{
			onResult: (o) => outcomes.push(o),
			onTimeout: () => {
				timedOut += 1;
			},
		},
	);
	return { outcomes, timedOutCount: () => timedOut };
}

describe("findEntry", () => {
	it("structuredContent の entry を拾う", () => {
		expect(findEntry({ structuredContent: { entry: ENTRY } })).toEqual(ENTRY);
	});

	it("content[].text のJSONから拾う", () => {
		expect(
			findEntry({
				content: [
					{ type: "text", text: "not json" },
					{ type: "text", text: JSON.stringify({ entry: ENTRY }) },
				],
			}),
		).toEqual(ENTRY);
	});

	it("result で包まれた形からも拾う", () => {
		expect(
			findEntry({ result: { structuredContent: { entry: ENTRY } } }),
		).toEqual(ENTRY);
	});

	it("mcp-ui の renderData 包みからも拾う", () => {
		expect(findEntry({ renderData: { entry: ENTRY } })).toEqual(ENTRY);
	});

	it("id の無い entry は採用しない", () => {
		expect(findEntry({ entry: { name: "Chablis" } })).toBeNull();
		expect(findEntry({ entry: { id: "" } })).toBeNull();
		expect(findEntry(null)).toBeNull();
		expect(findEntry("entry")).toBeNull();
	});
});

describe("ハンドシェイク", () => {
	it("中継への合図と両プロトコルの開始メッセージを送る", () => {
		const { bridge, posted } = setup();
		bridge.start();
		expect(posted[0]).toEqual(RELAY_READY_MESSAGE);
		expect(posted).toContainEqual(
			expect.objectContaining({ method: "ui/initialize", id: 1 }),
		);
		expect(posted).toContainEqual({ type: "ui-lifecycle-iframe-ready" });
		expect(posted).toContainEqual({ type: "ui-request-render-data" });
	});

	it("ui/initialize への応答で initialized を返す", () => {
		const { bridge, posted } = setup();
		completeSepHandshake(bridge);
		expect(posted).toContainEqual({
			jsonrpc: "2.0",
			method: "ui/notifications/initialized",
		});
	});
});

describe("エントリの受信", () => {
	it("SEP の tool-result から受け取る", () => {
		const { bridge, entries } = setup();
		bridge.handleMessage({
			method: "ui/notifications/tool-result",
			params: { structuredContent: { entry: ENTRY } },
		});
		expect(entries).toEqual([ENTRY]);
	});

	it("mcp-ui の render-data から受け取る", () => {
		const { bridge, entries } = setup();
		bridge.handleMessage({
			type: "ui-lifecycle-iframe-render-data",
			payload: { renderData: { entry: ENTRY } },
		});
		expect(entries).toEqual([ENTRY]);
	});

	it("エントリを含まない通知では通知しない", () => {
		const { bridge, entries } = setup();
		bridge.handleMessage({
			method: "ui/notifications/tool-result",
			params: { content: [{ type: "text", text: "{}" }] },
		});
		expect(entries).toEqual([]);
	});
});

describe("callTool (SEPモード)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		return () => vi.useRealTimers();
	});

	it("tools/call を送り、同じidの応答で確定する", () => {
		const { bridge, posted } = setup();
		completeSepHandshake(bridge);
		const { outcomes } = callAndCapture(bridge);

		const call = posted.at(-1) as {
			id: number;
			method: string;
			params: { name: string; arguments: Record<string, unknown> };
		};
		expect(call.method).toBe("tools/call");
		expect(call.params).toEqual({
			name: "update_drunk_wine",
			arguments: { id: "e1", name: "Chablis 1er" },
		});

		bridge.handleMessage({
			jsonrpc: "2.0",
			id: call.id,
			result: { structuredContent: { entry: ENTRY } },
		});
		expect(outcomes).toEqual([{ ok: true, entry: ENTRY }]);
	});

	it("JSON-RPC エラーを失敗として返す", () => {
		const { bridge, posted } = setup();
		completeSepHandshake(bridge);
		const { outcomes } = callAndCapture(bridge);
		const call = posted.at(-1) as { id: number };

		bridge.handleMessage({
			jsonrpc: "2.0",
			id: call.id,
			error: { message: "権限がありません" },
		});
		expect(outcomes).toEqual([{ ok: false, message: "権限がありません" }]);
	});

	it("isError のツール結果を失敗として返す", () => {
		const { bridge, posted } = setup();
		completeSepHandshake(bridge);
		const { outcomes } = callAndCapture(bridge);
		const call = posted.at(-1) as { id: number };

		bridge.handleMessage({
			jsonrpc: "2.0",
			id: call.id,
			result: {
				isError: true,
				content: [{ type: "text", text: "保存できません" }],
			},
		});
		expect(outcomes).toEqual([{ ok: false, message: "保存できません" }]);
	});

	it("別のidの応答では確定しない", () => {
		const { bridge, posted } = setup();
		completeSepHandshake(bridge);
		const { outcomes } = callAndCapture(bridge);
		const call = posted.at(-1) as { id: number };

		bridge.handleMessage({ jsonrpc: "2.0", id: call.id + 100, result: {} });
		expect(outcomes).toEqual([]);
	});

	it("タイムアウト後も遅れて届いた応答を反映する", () => {
		const { bridge, posted } = setup(1000);
		completeSepHandshake(bridge);
		const { outcomes, timedOutCount } = callAndCapture(bridge);
		const call = posted.at(-1) as { id: number };

		vi.advanceTimersByTime(1000);
		expect(timedOutCount()).toBe(1);
		expect(outcomes).toEqual([]);

		bridge.handleMessage({
			jsonrpc: "2.0",
			id: call.id,
			result: { structuredContent: { entry: ENTRY } },
		});
		expect(outcomes).toEqual([{ ok: true, entry: ENTRY }]);
	});

	it("応答済みの呼び出しはタイムアウトしない", () => {
		const { bridge, posted } = setup(1000);
		completeSepHandshake(bridge);
		const { timedOutCount } = callAndCapture(bridge);
		const call = posted.at(-1) as { id: number };

		bridge.handleMessage({ jsonrpc: "2.0", id: call.id, result: {} });
		vi.advanceTimersByTime(5000);
		expect(timedOutCount()).toBe(0);
	});
});

describe("callTool (mcp-uiモード)", () => {
	it("{type:'tool'} を送り ui-message-response で確定する", () => {
		const { bridge, posted } = setup();
		bridge.start();
		const { outcomes } = callAndCapture(bridge);

		const call = posted.at(-1) as {
			type: string;
			messageId: string;
			payload: { toolName: string; params: Record<string, unknown> };
		};
		expect(call.type).toBe("tool");
		expect(call.payload).toEqual({
			toolName: "update_drunk_wine",
			params: { id: "e1", name: "Chablis 1er" },
		});

		bridge.handleMessage({
			type: "ui-message-response",
			messageId: call.messageId,
			payload: { response: { structuredContent: { entry: ENTRY } } },
		});
		expect(outcomes).toEqual([{ ok: true, entry: ENTRY }]);
	});

	it("payload.error を失敗として返す", () => {
		const { bridge, posted } = setup();
		bridge.start();
		const { outcomes } = callAndCapture(bridge);
		const call = posted.at(-1) as { messageId: string };

		bridge.handleMessage({
			type: "ui-message-response",
			messageId: call.messageId,
			payload: { error: "ツールの実行が拒否されました" },
		});
		expect(outcomes).toEqual([
			{ ok: false, message: "ツールの実行が拒否されました" },
		]);
	});

	it("result で包まれた応答も剥がして扱う", () => {
		const { bridge, posted } = setup();
		bridge.start();
		const { outcomes } = callAndCapture(bridge);
		const call = posted.at(-1) as { messageId: string };

		bridge.handleMessage({
			type: "ui-message-response",
			messageId: call.messageId,
			payload: {
				response: {
					result: {
						content: [{ type: "text", text: JSON.stringify({ entry: ENTRY }) }],
					},
				},
			},
		});
		expect(outcomes).toEqual([{ ok: true, entry: ENTRY }]);
	});
});
