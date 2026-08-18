import type { ReceivedDrunkWineEntry } from "./entry";

// MCP App(ホストのサンドボックス iframe)とやり取りするブリッジ。
//
// 以前は apps.ts のテンプレート文字列内 vanilla JS がこの役割を担っていたが、
// typecheck も lint も効かず substring テストしか書けなかった(#155/#189)。
// フォーム本体を /embed/drunk-wine の実 React 実装へ移すのに合わせ、
// プロトコル実装もここへ引き上げて型と単体テストの対象にする。
//
// 対応するホスト:
//  - MCP Apps (SEP): JSON-RPC。`ui/initialize` に応答が返ればこのモードで、
//    ツール実行は `tools/call` を id 付きで送り、同じ id の応答を待つ。
//  - mcp-ui: `ui-lifecycle-iframe-*` 系のメッセージ。ツール実行は
//    `{type:"tool", messageId}` を送り、`ui-message-response` を待つ。
// どちらか判別できないうちは mcp-ui として扱い、SEP の応答を受けた時点で
// 切り替える(現行の App HTML と同じ挙動)。
//
// window に直接触らないのは、ブラウザ無しで全分岐をテストできるようにするため。
// 実際の window への接続は connectHostBridge が行う。

const TOOL_CALL_TIMEOUT_MS = 60_000;

export type ToolCallOutcome =
	| { ok: true; entry: ReceivedDrunkWineEntry | null }
	| { ok: false; message: string };

interface ToolCallHandlers {
	/**
	 * ホストからツール応答が届いた。タイムアウト後に遅れて届くこともあるため、
	 * onTimeout の後に呼ばれうる。
	 */
	onResult: (outcome: ToolCallOutcome) => void;
	/**
	 * 応答待ちがタイムアウトした。ホストがツール実行のユーザ承認を挟む場合が
	 * あるので、これは失敗確定ではない(pending は保持し続ける)。
	 */
	onTimeout: () => void;
}

export interface HostBridgeOptions {
	/** ホスト(親フレーム)へメッセージを送る。 */
	post: (message: unknown) => void;
	/** ツール結果 / render-data からエントリを受け取った。 */
	onEntry: (entry: ReceivedDrunkWineEntry) => void;
	timeoutMs?: number;
}

export interface HostBridge {
	/** 両プロトコルのハンドシェイクを送る(どちらのホストでも通るよう両方送る)。 */
	start: () => void;
	/** ホストから届いたメッセージ(event.data)を処理する。 */
	handleMessage: (data: unknown) => void;
	callTool: (
		name: string,
		args: Record<string, unknown>,
		handlers: ToolCallHandlers,
	) => void;
	/** 保留中のタイマを全て解除する(アンマウント時)。 */
	dispose: () => void;
}

interface PendingCall {
	kind: "sep" | "ui";
	timer: ReturnType<typeof setTimeout>;
	handlers: ToolCallHandlers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * ツール結果 / render-data のペイロードから `{ entry: {...} }` を探す。
 * ホストによって tool-result の params の形が違う(structuredContent か、
 * content[].text の JSON か、mcp-ui の renderData 包み)ため、ありうる位置を
 * 順に見る。id を持つ entry が見つかった最初のものを採用する。
 */
export function findEntry(payload: unknown): ReceivedDrunkWineEntry | null {
	if (!isRecord(payload)) return null;

	const candidates: unknown[] = [payload];
	const result = isRecord(payload.result) ? payload.result : undefined;

	const structured = payload.structuredContent ?? result?.structuredContent;
	if (structured !== undefined) candidates.push(structured);

	const renderData = isRecord(payload.renderData)
		? payload.renderData
		: undefined;
	const content = payload.content ?? result?.content ?? renderData?.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (
				isRecord(part) &&
				part.type === "text" &&
				typeof part.text === "string"
			) {
				try {
					candidates.push(JSON.parse(part.text));
				} catch {
					// テキストがJSONでないホストもある。他の候補で探す
				}
			}
		}
	}

	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const entry = candidate.entry;
		if (isRecord(entry) && typeof entry.id === "string" && entry.id) {
			return entry as ReceivedDrunkWineEntry;
		}
	}

	// mcp-ui は payload を renderData で包むことがある
	if (renderData) return findEntry(renderData);
	return null;
}

/** ツール応答(SEP の result / mcp-ui の response)からエラーメッセージを取り出す。 */
function errorTextOf(result: unknown): string | null {
	if (!isRecord(result)) return null;
	if (!result.isError) return null;
	const content = result.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (
				isRecord(part) &&
				part.type === "text" &&
				typeof part.text === "string"
			) {
				return part.text;
			}
		}
	}
	return "";
}

export function createHostBridge(options: HostBridgeOptions): HostBridge {
	const timeoutMs = options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS;
	// SEP ホストだと確定するまでは mcp-ui として振る舞う
	let sepMode = false;
	// ui/initialize は id:1 固定。ツール呼び出しは 2 から採番する
	let nextId = 2;
	const pending = new Map<string | number, PendingCall>();

	function settle(key: string | number, outcome: ToolCallOutcome) {
		const call = pending.get(key);
		if (!call) return;
		clearTimeout(call.timer);
		pending.delete(key);
		call.handlers.onResult(outcome);
	}

	function handleToolResponse(key: string | number, result: unknown) {
		// SEP は {result:{content,...}}、mcp-ui は payload.response が
		// ツール結果そのもののことがあるので、両方を剥がしてから見る
		const unwrapped =
			isRecord(result) &&
			isRecord(result.result) &&
			(result.result.content !== undefined ||
				result.result.structuredContent !== undefined ||
				result.result.isError !== undefined)
				? result.result
				: result;

		const errorText = errorTextOf(unwrapped);
		if (errorText !== null) {
			settle(key, { ok: false, message: errorText || "保存に失敗しました" });
			return;
		}
		settle(key, { ok: true, entry: findEntry(unwrapped) });
	}

	return {
		start() {
			// 中継フレームにバッファの解放を促す(ホスト直下で描画された場合は
			// 誰も解釈しないメッセージとして無視される)
			options.post(RELAY_READY_MESSAGE);
			// どちらのハンドシェイクにも応答できるよう両方送る
			options.post({
				jsonrpc: "2.0",
				id: 1,
				method: "ui/initialize",
				params: {
					protocolVersion: "2025-06-18",
					appInfo: { name: "wine-aop", version: "1.0.0" },
					appCapabilities: {},
				},
			});
			options.post({ type: "ui-lifecycle-iframe-ready" });
			options.post({ type: "ui-request-render-data" });
		},

		handleMessage(data: unknown) {
			if (!isRecord(data)) return;

			// ui/initialize への応答 → SEP モード確定
			if (data.id === 1 && data.result !== undefined) {
				sepMode = true;
				options.post({
					jsonrpc: "2.0",
					method: "ui/notifications/initialized",
				});
				return;
			}

			if (data.method === "ui/notifications/tool-result") {
				const entry = findEntry(data.params);
				if (entry) options.onEntry(entry);
				return;
			}

			if (data.type === "ui-lifecycle-iframe-render-data") {
				const entry = findEntry(data.payload);
				if (entry) options.onEntry(entry);
				return;
			}

			// SEP のツール応答: 送信時の id で突き合わせる
			if (
				data.jsonrpc === "2.0" &&
				(typeof data.id === "number" || typeof data.id === "string")
			) {
				const call = pending.get(data.id);
				if (call?.kind === "sep") {
					if (isRecord(data.error)) {
						const message = data.error.message;
						settle(data.id, {
							ok: false,
							message:
								typeof message === "string" && message
									? message
									: "保存に失敗しました",
						});
					} else {
						handleToolResponse(data.id, data.result);
					}
					return;
				}
			}

			// mcp-ui のツール応答
			if (
				data.type === "ui-message-response" &&
				typeof data.messageId === "string"
			) {
				const call = pending.get(data.messageId);
				if (call?.kind === "ui") {
					const payload = isRecord(data.payload) ? data.payload : {};
					if (payload.error) {
						settle(data.messageId, {
							ok: false,
							message:
								typeof payload.error === "string"
									? payload.error
									: "保存に失敗しました",
						});
					} else {
						handleToolResponse(data.messageId, payload.response);
					}
				}
			}
		},

		callTool(name, args, handlers) {
			const key: string | number = sepMode ? nextId++ : `${name}-${nextId++}`;
			// タイムアウトしても pending は消さない。ホストがツール実行の承認を
			// 挟んでいるだけのことがあり、その場合は後から応答が届く
			const timer = setTimeout(() => {
				if (pending.has(key)) handlers.onTimeout();
			}, timeoutMs);
			pending.set(key, { kind: sepMode ? "sep" : "ui", timer, handlers });

			if (sepMode) {
				options.post({
					jsonrpc: "2.0",
					id: key,
					method: "tools/call",
					params: { name, arguments: args },
				});
			} else {
				options.post({
					type: "tool",
					messageId: key,
					payload: { toolName: name, params: args },
				});
			}
		},

		dispose() {
			for (const call of pending.values()) clearTimeout(call.timer);
			pending.clear();
		},
	};
}

// App を包む中継フレーム(apps.ts)へ「子の準備ができた」ことを知らせる合図。
// 中継はこれを受け取るまでホストからのメッセージをバッファする(ネスト構成では
// render-data が子のロード完了前に届きうるため)。中継はこの合図をホストへ
// 転送しない。
export const RELAY_READY_MESSAGE = { __wineRelay: "ready" } as const;

/**
 * ブリッジを実際の window に接続する。親フレーム(= 中継フレーム。SEP ホストの
 * サンドボックス iframe なので origin は "null" になる)以外からのメッセージは
 * 受け付けない。origin では検証できないため source で判定する。
 *
 * このページは認証情報を一切扱わず(表示データはホスト由来、書き込みはホスト
 * 仲介の tools/call)、送受信するのは編集中のフォーム内容だけなので、
 * targetOrigin は "*" で構わない(不透明オリジンの親には他に指定しようがない)。
 */
export function connectHostBridge(
	options: Omit<HostBridgeOptions, "post">,
): HostBridge {
	const bridge = createHostBridge({
		...options,
		post: (message) => {
			try {
				window.parent.postMessage(message, "*");
			} catch {
				// ホストが受け取れない構造でも App 側は動作を続ける
			}
		},
	});

	const onMessage = (event: MessageEvent) => {
		if (event.source !== window.parent) return;
		bridge.handleMessage(event.data);
	};
	window.addEventListener("message", onMessage);

	const dispose = bridge.dispose;
	return {
		...bridge,
		dispose() {
			window.removeEventListener("message", onMessage);
			dispose();
		},
	};
}
