import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { InsufficientCreditsDialog } from "#/components/credit/InsufficientCreditsDialog";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import {
	AI_REGION_QA_MODELS,
	DEFAULT_REGION_QA_MODEL,
	REGION_QA_MODEL_KEYS,
	type RegionQaModelKey,
} from "#/lib/ai/config";
import { authClient } from "#/lib/auth-client";
import {
	BILLING_STATUS_QUERY_KEY,
	useBillingStatus,
} from "#/lib/billing/use-billing";
import {
	CREDIT_BALANCE_QUERY_KEY,
	useCreditBalance,
} from "#/lib/credit/use-credit";
import { getSession } from "#/server/auth";
import { redeemExtensionCode } from "#/server/billing";
import { consumeCreditsDummy } from "#/server/credit";

interface ProfileSearch {
	/** Stripe Checkout 成功時の戻りで付与される */
	checkout?: "success";
}

export const Route = createFileRoute("/profile")({
	validateSearch: (search: Record<string, unknown>): ProfileSearch => ({
		checkout: search.checkout === "success" ? "success" : undefined,
	}),
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	component: ProfilePage,
});

function ProfilePage() {
	const { data: session, refetch: refetchSession } = authClient.useSession();

	const [name, setName] = useState("");
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [error, setError] = useState("");
	const [successMessage, setSuccessMessage] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (session?.user.name) setName(session.user.name);
	}, [session?.user.name]);

	const { mutate: saveName, isPending: savingName } = useMutation({
		mutationFn: async () => {
			const result = await authClient.updateUser({ name });
			if (result.error)
				throw new Error(result.error.message ?? "Update failed");
		},
		onSuccess: async () => {
			await refetchSession();
			setSuccessMessage("名前を更新しました。");
			setError("");
		},
		onError: (err: Error) => {
			setError(err.message);
			setSuccessMessage("");
		},
	});

	const { mutate: uploadAvatar, isPending: uploadingAvatar } = useMutation({
		mutationFn: async () => {
			if (!selectedFile) return;
			const form = new FormData();
			form.append("avatar", selectedFile);
			const res = await fetch("/api/upload", { method: "POST", body: form });
			if (!res.ok) {
				const body = (await res.json()) as { error?: string };
				throw new Error(body.error ?? "Upload failed");
			}
			const { imageUrl } = (await res.json()) as { imageUrl: string };
			const result = await authClient.updateUser({ image: imageUrl });
			if (result.error)
				throw new Error(result.error.message ?? "Profile update failed");
		},
		onSuccess: async () => {
			await refetchSession();
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
				setPreviewUrl(null);
			}
			setSelectedFile(null);
			if (fileInputRef.current) fileInputRef.current.value = "";
			setSuccessMessage("プロフィール画像を更新しました。");
			setError("");
		},
		onError: (err: Error) => {
			setError(err.message);
			setSuccessMessage("");
		},
	});

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0] ?? null;
		if (!file) return;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		setSelectedFile(file);
		setPreviewUrl(URL.createObjectURL(file));
	};

	const currentAvatarUrl = previewUrl ?? session?.user.image ?? null;
	const userInitial = session?.user.name?.charAt(0).toUpperCase() ?? "U";
	const isPending = savingName || uploadingAvatar;

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<h1 className="mb-6 text-2xl font-bold">プロフィール</h1>
			<Card>
				<CardHeader>
					<CardTitle>プロフィール編集</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-6">
					<div className="flex flex-col gap-3">
						<Label>プロフィール画像</Label>
						<div className="flex items-center gap-4">
							{currentAvatarUrl ? (
								<img
									src={currentAvatarUrl}
									alt="アバタープレビュー"
									className="h-16 w-16 rounded-full object-cover border border-border"
								/>
							) : (
								<div className="h-16 w-16 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center border border-border">
									<span className="text-xl font-medium text-neutral-600 dark:text-neutral-400">
										{userInitial}
									</span>
								</div>
							)}
							<div className="flex flex-col gap-2">
								<Input
									ref={fileInputRef}
									type="file"
									accept="image/jpeg,image/png,image/webp,image/gif"
									onChange={handleFileChange}
									className="max-w-xs"
								/>
								<p className="text-xs text-muted-foreground">
									JPEG・PNG・WebP・GIF、最大5MB
								</p>
							</div>
						</div>
						{selectedFile && (
							<Button
								type="button"
								disabled={isPending}
								onClick={() => uploadAvatar()}
								className="self-start"
							>
								{uploadingAvatar ? "アップロード中..." : "画像をアップロード"}
							</Button>
						)}
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="display-name">表示名</Label>
						<Input
							id="display-name"
							type="text"
							placeholder="お名前"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>

					{error && <p className="text-sm text-destructive">{error}</p>}
					{successMessage && (
						<p className="text-sm text-green-600 dark:text-green-400">
							{successMessage}
						</p>
					)}

					<Button
						type="button"
						disabled={isPending || !name.trim()}
						onClick={() => saveName()}
						className="self-start"
					>
						{savingName ? "保存中..." : "名前を保存"}
					</Button>
				</CardContent>
			</Card>

			<AiModelCard />
			<PlanCard />
			<CreditCard />
		</main>
	);
}

/**
 * 地域Q&AチャットのAIモデル選択。ユーザ設定として user.preferredAiModel に保存し、
 * チャット側はこの設定を使う(チャット画面ではモデルを選べない)。
 */
function AiModelCard() {
	const { data: session, refetch: refetchSession } = authClient.useSession();
	const [model, setModel] = useState<RegionQaModelKey>(DEFAULT_REGION_QA_MODEL);
	const [error, setError] = useState("");
	const [successMessage, setSuccessMessage] = useState("");

	useEffect(() => {
		const pref = session?.user.preferredAiModel;
		if (pref && (REGION_QA_MODEL_KEYS as readonly string[]).includes(pref)) {
			setModel(pref as RegionQaModelKey);
		}
	}, [session?.user.preferredAiModel]);

	const { mutate: saveModel, isPending } = useMutation({
		mutationFn: async () => {
			const result = await authClient.updateUser({ preferredAiModel: model });
			if (result.error)
				throw new Error(result.error.message ?? "Update failed");
		},
		onSuccess: async () => {
			await refetchSession();
			setSuccessMessage("AIモデルを更新しました。");
			setError("");
		},
		onError: (err: Error) => {
			setError(err.message);
			setSuccessMessage("");
		},
	});

	return (
		<Card className="mt-6">
			<CardHeader>
				<CardTitle>AIモデル</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					地域について質問するAIチャットで使うモデルを選べます。
				</p>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="ai-model">モデル</Label>
					<Select
						value={model}
						onValueChange={(v) => setModel(v as RegionQaModelKey)}
					>
						<SelectTrigger id="ai-model" className="max-w-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(AI_REGION_QA_MODELS).map(([key, m]) => (
								<SelectItem key={key} value={key}>
									{m.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{error && <p className="text-sm text-destructive">{error}</p>}
				{successMessage && (
					<p className="text-sm text-green-600 dark:text-green-400">
						{successMessage}
					</p>
				)}

				<Button
					type="button"
					disabled={isPending}
					onClick={() => saveModel()}
					className="self-start"
				>
					{isPending ? "保存中..." : "モデルを保存"}
				</Button>
			</CardContent>
		</Card>
	);
}

/**
 * AIクレジットの残高表示と、ダミー消費で予約→確定→残高不足ブロックを検証するカード。
 * Workers AI 導入前(PR1)の動作確認用。実際のAI推論は行わない。
 */
function CreditCard() {
	const queryClient = useQueryClient();
	const { data, isPending, isError } = useCreditBalance();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	const { mutate: consume, isPending: consuming } = useMutation({
		mutationFn: () => consumeCreditsDummy({ data: { estimateTokens: 2000 } }),
		onSuccess: (result) => {
			void queryClient.invalidateQueries({
				queryKey: CREDIT_BALANCE_QUERY_KEY,
			});
			if (result.blocked) {
				setMessage("");
				setDialogOpen(true);
				return;
			}
			setError("");
			setMessage(
				`ダミー消費が成功しました(予約 ${result.reservedCredits} / 実測 ${result.actualTokens} トークン)。残高: ${result.balance}`,
			);
		},
		onError: (err: Error) => {
			setMessage("");
			setError(err.message || "消費に失敗しました。");
		},
	});

	const balanceLabel =
		isPending || isError || !data?.authenticated || data.balance === null
			? null
			: data.balance.toLocaleString("ja-JP");

	return (
		<Card className="mt-6">
			<CardHeader>
				<CardTitle>AIクレジット</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{isPending ? (
					<p className="text-sm text-muted-foreground">読み込み中...</p>
				) : isError ? (
					<p className="text-sm text-destructive">
						クレジット残高を取得できませんでした。再読み込みしてください。
					</p>
				) : (
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground">今月の残高:</span>
						<span className="font-medium tabular-nums">
							{balanceLabel ?? "—"}
						</span>
					</div>
				)}

				<Button
					type="button"
					variant="outline"
					className="self-start"
					disabled={consuming || balanceLabel === null}
					onClick={() => consume()}
				>
					{consuming ? "消費中..." : "クレジットを消費(ダミー)"}
				</Button>

				<p className="text-xs text-muted-foreground">
					AI機能導入前の動作確認用ボタンです。実際のAI推論は行いません。
				</p>

				{message && (
					<p className="text-sm text-green-600 dark:text-green-400">
						{message}
					</p>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
			</CardContent>
			<InsufficientCreditsDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
			/>
		</Card>
	);
}

const SUBSCRIPTIONS_QUERY_KEY = ["subscriptions"] as const;

function PlanCard() {
	const { checkout } = Route.useSearch();
	const navigate = Route.useNavigate();
	const queryClient = useQueryClient();
	const billingQuery = useBillingStatus();
	const billing = billingQuery.data;
	const [actionError, setActionError] = useState("");
	const [checkoutSuccess, setCheckoutSuccess] = useState(false);

	const { data: subscriptions, isError: subscriptionsError } = useQuery({
		queryKey: SUBSCRIPTIONS_QUERY_KEY,
		queryFn: async () => {
			const result = await authClient.subscription.list();
			if (result.error) {
				throw new Error(
					result.error.message ?? "プラン情報の取得に失敗しました",
				);
			}
			return result.data;
		},
	});

	// checkout=success は state に退避し、URLからは取り除く(リロードや
	// ブックマークでお礼メッセージ・再取得が繰り返されるのを防ぐ)。
	useEffect(() => {
		if (checkout !== "success") return;
		setCheckoutSuccess(true);
		void navigate({ search: {}, replace: true });
	}, [checkout, navigate]);

	// Checkout 成功直後は webhook 反映ラグでまだ無料プラン表示になり得るため、
	// 到着時に加えて数秒後にもう一度取り直す。
	useEffect(() => {
		if (!checkoutSuccess) return;
		const invalidate = () => {
			void queryClient.invalidateQueries({
				queryKey: BILLING_STATUS_QUERY_KEY,
			});
			void queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_QUERY_KEY });
		};
		invalidate();
		const timer = setTimeout(invalidate, 4000);
		return () => clearTimeout(timer);
	}, [checkoutSuccess, queryClient]);

	const isPremium = billing?.isPremium ?? false;
	const activeSubscription = subscriptions?.find(
		(sub) => sub.status === "active" || sub.status === "trialing",
	);

	// 戻り先はプラグインが BETTER_AUTH_URL 基準で絶対URL化するため、カスタム
	// ドメイン等の別ホストから操作しても元のホストに戻れるよう絶対URLで渡す。
	const profileReturnUrl = () => `${window.location.origin}/profile`;

	const { mutate: openBillingPortal, isPending: openingPortal } = useMutation({
		mutationFn: async () => {
			// 成功時は better-auth クライアントが Stripe Billing Portal へ自動リダイレクトする
			const result = await authClient.subscription.billingPortal({
				returnUrl: profileReturnUrl(),
			});
			if (result.error) {
				throw new Error(
					result.error.message ?? "支払い管理画面を開けませんでした",
				);
			}
		},
		onError: (err: Error) => setActionError(err.message),
	});

	const { mutate: cancelSubscription, isPending: canceling } = useMutation({
		mutationFn: async () => {
			// Stripe Billing Portal の解約フローへ自動リダイレクトする
			const result = await authClient.subscription.cancel({
				returnUrl: profileReturnUrl(),
			});
			if (result.error) {
				throw new Error(
					result.error.message ?? "解約手続きを開始できませんでした",
				);
			}
		},
		onError: (err: Error) => setActionError(err.message),
	});

	const { mutate: restoreSubscription, isPending: restoring } = useMutation({
		mutationFn: async () => {
			const result = await authClient.subscription.restore({});
			if (result.error) {
				throw new Error(result.error.message ?? "解約の取り消しに失敗しました");
			}
		},
		onSuccess: () => {
			setActionError("");
			void queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_QUERY_KEY });
		},
		onError: (err: Error) => setActionError(err.message),
	});

	const actionPending = openingPortal || canceling || restoring;
	const periodEndLabel = activeSubscription?.periodEnd
		? new Date(activeSubscription.periodEnd).toLocaleDateString("ja-JP")
		: null;

	return (
		<Card className="mt-6">
			<CardHeader>
				<CardTitle>プラン</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{checkoutSuccess && (
					<p className="text-sm text-green-600 dark:text-green-400">
						ご購入ありがとうございます。反映まで少し時間がかかる場合があります。
					</p>
				)}

				{billingQuery.isPending ? (
					<p className="text-sm text-muted-foreground">読み込み中...</p>
				) : billingQuery.isError ? (
					<p className="text-sm text-destructive">
						プラン情報を取得できませんでした。再読み込みしてください。
					</p>
				) : (
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground">現在のプラン:</span>
						<span className="font-medium">
							{isPremium ? "プレミアム" : "無料プラン"}
						</span>
						{activeSubscription?.cancelAtPeriodEnd && (
							<span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
								解約予約中
							</span>
						)}
					</div>
				)}

				{isPremium && periodEndLabel && (
					<p className="text-sm text-muted-foreground">
						{activeSubscription?.cancelAtPeriodEnd
							? `${periodEndLabel} までプレミアム特典をご利用いただけます。`
							: `次回更新日: ${periodEndLabel}`}
					</p>
				)}

				{actionError && (
					<p className="text-sm text-destructive">{actionError}</p>
				)}

				{billingQuery.isPending || billingQuery.isError ? null : isPremium ? (
					<div className="flex flex-col gap-2">
						{subscriptionsError && (
							<p className="text-sm text-destructive">
								契約情報を取得できませんでした。解約状態の表示・操作は再読み込み後にお試しください。
							</p>
						)}
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								disabled={actionPending}
								onClick={() => openBillingPortal()}
							>
								{openingPortal ? "開いています..." : "支払いの管理"}
							</Button>
							{/* 解約/取り消しは契約情報(解約予約の有無)が取れている時のみ出す。
							    取得失敗時に「解約する」を出すと解約予約中でも二重に見えるため */}
							{!subscriptionsError &&
								subscriptions !== undefined &&
								(activeSubscription?.cancelAtPeriodEnd ? (
									<Button
										type="button"
										variant="outline"
										disabled={actionPending}
										onClick={() => restoreSubscription()}
									>
										{restoring ? "処理中..." : "解約を取り消す"}
									</Button>
								) : (
									<Button
										type="button"
										variant="outline"
										disabled={actionPending}
										onClick={() => cancelSubscription()}
									>
										{canceling ? "処理中..." : "解約する"}
									</Button>
								))}
						</div>
						<ExtensionCodeForm />
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<Button asChild className="self-start">
							<Link to="/pricing">プレミアムにアップグレード</Link>
						</Button>
						<p className="text-xs text-muted-foreground">
							月額300円(年払いなら3,000円で2ヶ月分お得)。広告非表示などの特典があります。
						</p>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

/**
 * キャンペーンコードを入力して自分の契約期間を延長するフォーム(プレミアム会員向け)。
 * 成功時は課金ステータス・契約情報を再取得する(webhook 反映ラグを見込んで数秒後にも)。
 */
function ExtensionCodeForm() {
	const queryClient = useQueryClient();
	const [code, setCode] = useState("");
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	const { mutate: redeem, isPending } = useMutation({
		mutationFn: async () => {
			const result = await redeemExtensionCode({ data: { code } });
			return result;
		},
		onSuccess: (result) => {
			setError("");
			setCode("");
			const until = new Date(result.newPeriodEnd).toLocaleDateString("ja-JP");
			setMessage(
				`${result.extendedDays}日間延長しました。${until} まで有効です(反映まで少し時間がかかる場合があります)。`,
			);
			const invalidate = () => {
				void queryClient.invalidateQueries({
					queryKey: BILLING_STATUS_QUERY_KEY,
				});
				void queryClient.invalidateQueries({
					queryKey: SUBSCRIPTIONS_QUERY_KEY,
				});
			};
			invalidate();
			setTimeout(invalidate, 4000);
		},
		onError: (err: Error) => {
			setMessage("");
			setError(err.message || "コードを適用できませんでした。");
		},
	});

	const trimmed = code.trim();

	return (
		<div className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
			<Label htmlFor="campaign-code" className="text-sm">
				キャンペーンコード
			</Label>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					id="campaign-code"
					type="text"
					placeholder="コードを入力"
					value={code}
					onChange={(e) => setCode(e.target.value)}
					className="max-w-xs"
					disabled={isPending}
				/>
				<Button
					type="button"
					variant="outline"
					disabled={isPending || !trimmed}
					onClick={() => redeem()}
				>
					{isPending ? "適用中..." : "適用する"}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				キャンペーンコードで契約期間を延長できます。
			</p>
			{message && (
				<p className="text-sm text-green-600 dark:text-green-400">{message}</p>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
		</div>
	);
}
