import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	DrunkWineEmbedForm,
	type EmbedSaveStatus,
} from "#/components/cellar/DrunkWineEmbedForm";
import type { DrunkWinePatch } from "#/lib/drunk-wine/fields";
import type { ReceivedDrunkWineEntry } from "#/lib/mcp-app/entry";
import { connectHostBridge, type HostBridge } from "#/lib/mcp-app/host-bridge";

// エントリを受信できないホストだと分かるまでの猶予。
const ENTRY_WAIT_MS = 10_000;

/**
 * 写真URLの検証に使う自オリジン。サンドボックス iframe の中では文書のオリジンが
 * 不透明になり `location.origin` が "null" を返すため、URL文字列から解決する。
 */
function selfOrigin(): string {
	if (typeof window === "undefined") return "";
	try {
		return new URL(window.location.href).origin;
	} catch {
		return "";
	}
}

// MCP Apps ホスト(Claude 等)の iframe に埋め込まれる「飲んだワイン」編集フォーム。
//
// 認証は一切しない。表示するエントリはホストからの postMessage で届き、保存は
// ホスト仲介の tools/call(update_drunk_wine)で行うため、このページ自身は
// クレデンシャルを必要としない。したがってサードパーティ iframe に Cookie が
// 乗らない環境でも動作する。エントリIDをURLに載せないのも同じ理由(IDOR防止)で、
// URLからは誰のどのエントリかを一切特定できない。
//
// ホストのサンドボックス属性は子フレームにも継承されるため、このページは
// allow-same-origin 無し(不透明オリジン)で動く前提にする: localStorage も
// server fn も使わず、描画に必要なデータは静的マスタとホストからの受信のみ。
export const Route = createFileRoute("/embed/drunk-wine")({
	// ルート既定の frame-ancestors 'none' を打ち消して埋め込みを許可する。
	// `frame-ancestors *` では足りない: MCP Apps ホストは App のHTMLを sandbox
	// (allow-same-origin 無し)の iframe で描画するため、その中から開くこの
	// ページの祖先オリジンは不透明("null")になり、ネットワークスキームのURLしか
	// 一致しない `*` にマッチせず読み込み自体が拒否される。空のポリシー(=祖先の
	// 制限なし)にして、どんな祖先からでも埋め込めるようにする。認証情報も
	// ユーザ固有データも持たないページなので、埋め込みで奪えるものは無い。
	headers: () => ({
		"Content-Security-Policy": "",
	}),
	component: EmbedDrunkWinePage,
});

function EmbedDrunkWinePage() {
	const [entry, setEntry] = useState<ReceivedDrunkWineEntry | null>(null);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<EmbedSaveStatus | null>(null);
	const [waitTimedOut, setWaitTimedOut] = useState(false);
	const bridgeRef = useRef<HostBridge | null>(null);

	useEffect(() => {
		const bridge = connectHostBridge({ onEntry: setEntry });
		bridgeRef.current = bridge;
		bridge.start();
		const timer = setTimeout(() => setWaitTimedOut(true), ENTRY_WAIT_MS);
		return () => {
			clearTimeout(timer);
			bridge.dispose();
			bridgeRef.current = null;
		};
	}, []);

	const handleSave = useCallback(
		(patch: DrunkWinePatch) => {
			const bridge = bridgeRef.current;
			if (!bridge || !entry) return;
			setSaving(true);
			setStatus({ text: "保存中…", kind: "ok" });
			bridge.callTool(
				"update_drunk_wine",
				// id はここでだけ付ける。フォームは id を意識しない
				{ ...patch, id: entry.id },
				{
					onTimeout: () => {
						setSaving(false);
						setStatus({
							text: "ホストの応答がありません(ツール実行の承認待ちの可能性があります)",
							kind: "error",
						});
					},
					onResult: (outcome) => {
						setSaving(false);
						if (!outcome.ok) {
							setStatus({ text: outcome.message, kind: "error" });
							return;
						}
						// 差分の基準だけをサーバ確定値へ更新する(フォームは作り直さない)
						if (outcome.entry) setEntry(outcome.entry);
						setStatus({ text: "保存しました", kind: "ok" });
					},
				},
			);
		},
		[entry],
	);

	if (!entry) {
		return (
			<p className="p-4 text-sm text-muted-foreground">
				{waitTimedOut
					? "登録結果を受信できませんでした。ホストがツール結果の配信(MCP Apps / mcp-ui)に対応している必要があります。"
					: "登録結果を待っています…"}
			</p>
		);
	}

	return (
		<DrunkWineEmbedForm
			key={entry.id}
			entry={entry}
			baseUrl={selfOrigin()}
			onSave={handleSave}
			saving={saving}
			status={status}
			onNoChanges={() => setStatus({ text: "変更はありません", kind: "ok" })}
		/>
	);
}
