import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
	isPushSupported,
	pushPermission,
	subscribeToPush,
	unsubscribeFromPush,
} from "#/lib/push/client";
import {
	deletePushSubscription,
	getPushStatus,
	savePushSubscription,
} from "#/server/ai";

// エチケット解析の完了通知(Web Push)の購読トグル(Issue #466)。
//
// **出さない条件が3つある**ので、それぞれ違う案内にする:
//  1. サーバに VAPID 鍵が無い → 機能ごと存在しない。カードを出さない
//  2. ブラウザが非対応(iOS の非PWA Safari 等)→ 理由を書いて出す(押せる物は出さない)
//  3. 通知が「拒否」→ トグルでは戻せない。ブラウザ設定からと案内する
//
// これを1つの `disabled` に畳むと「押しても何も起きないスイッチ」になる。

const PUSH_STATUS_QUERY_KEY = ["push-status"] as const;

export function PushNotificationCard() {
	const queryClient = useQueryClient();
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const { data: status } = useQuery({
		queryKey: PUSH_STATUS_QUERY_KEY,
		queryFn: () => getPushStatus(),
		staleTime: 60_000,
	});

	const { mutate: toggle, isPending } = useMutation({
		mutationFn: async (enable: boolean) => {
			if (enable) {
				// 公開鍵が無い環境ではカード自体を出さないので、ここに来る時点で必ずある。
				const input = await subscribeToPush(status?.publicKey ?? "");
				await savePushSubscription({ data: input });
				return true;
			}
			const endpoint = await unsubscribeFromPush();
			// ブラウザ側に購読が無くてもサーバに行が残っていることがある(別端末で解除した
			// 場合など)。endpoint が取れないときは消しようがないので、そのまま返す。
			if (endpoint) await deletePushSubscription({ data: { endpoint } });
			return false;
		},
		onSuccess: (enabled) => {
			setError("");
			setNotice(
				enabled
					? "解析が完了したときに通知を受け取ります。"
					: "通知を停止しました。",
			);
			void queryClient.invalidateQueries({ queryKey: PUSH_STATUS_QUERY_KEY });
		},
		onError: (e: Error) => {
			setNotice("");
			setError(e.message || "通知の設定を変更できませんでした");
		},
	});

	// サーバに鍵が無い = この環境では機能そのものが無い。導線ごと隠す。
	if (!status || status.publicKey === null) return null;

	const supported = isPushSupported();
	const permission = pushPermission();

	return (
		<Card className="mt-6">
			<CardHeader>
				<CardTitle>解析完了の通知</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					エチケットの解析は写真の拡大や裏取りを挟むため、完了まで数十秒かかります。
					通知を有効にすると、アプリを閉じていても完了したときに知らせます。
				</p>

				{!supported && (
					<p className="text-sm text-muted-foreground">
						このブラウザは通知に対応していません。iPhone
						では、ホーム画面に追加してから開くと有効にできます。
					</p>
				)}

				{supported && permission === "denied" && (
					<p className="text-sm text-muted-foreground">
						このサイトの通知がブラウザ側で拒否されています。ブラウザの設定から許可すると有効にできます。
					</p>
				)}

				{supported && permission !== "denied" && (
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="button"
							variant={status.subscribed ? "outline" : "default"}
							disabled={isPending}
							onClick={() => {
								setError("");
								setNotice("");
								toggle(!status.subscribed);
							}}
						>
							{isPending
								? "設定中..."
								: status.subscribed
									? "通知を停止する"
									: "通知を有効にする"}
						</Button>
						<span className="text-sm text-muted-foreground">
							{status.subscribed
								? "このブラウザで通知を受け取ります"
								: "有効にすると、このブラウザで通知を受け取ります"}
						</span>
					</div>
				)}

				{notice && <p className="text-sm text-muted-foreground">{notice}</p>}
				{error && <p className="text-sm text-destructive">{error}</p>}
			</CardContent>
		</Card>
	);
}
