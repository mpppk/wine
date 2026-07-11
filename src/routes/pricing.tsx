import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { authClient } from "#/lib/auth-client";
import {
	PREMIUM_PLAN_NAME,
	PREMIUM_PRICING,
	PREMIUM_TRIAL_DAYS,
} from "#/lib/billing/plans";
import { useBillingStatus } from "#/lib/billing/use-billing";

export const Route = createFileRoute("/pricing")({
	component: PricingPage,
});

const FREE_FEATURES = [
	"クイズ・地図・マイセラーなど全機能",
	"学習進捗の記録",
	"広告が表示されます(今後導入予定)",
];

const PREMIUM_FEATURES = [
	`最初の${PREMIUM_TRIAL_DAYS}日間は無料でお試し`,
	"無料プランの全機能",
	"広告が非表示(今後導入予定の広告を含む)",
	"今後追加されるプレミアム特典",
];

function PricingPage() {
	const navigate = useNavigate();
	const { data: session } = authClient.useSession();
	const billingQuery = useBillingStatus();
	const billing = billingQuery.data;
	const [annual, setAnnual] = useState(false);
	const [upgradeError, setUpgradeError] = useState("");
	const [upgrading, setUpgrading] = useState(false);

	const isPremium = billing?.isPremium ?? false;
	// 取得前・取得失敗時は楽観的に有効とみなす(未設定ならサーバー側が4xxで弾く)。
	// false に倒すと、ロード中のフラッシュや取得失敗で購入導線が消えてしまう。
	const stripeConfigured = billing?.stripeConfigured ?? true;

	// Stripe Checkout からブラウザバック(bfcache復元)で戻ると upgrading=true の
	// まま固まるため、復元時にリセットする。
	useEffect(() => {
		const onPageShow = (e: PageTransitionEvent) => {
			if (e.persisted) setUpgrading(false);
		};
		window.addEventListener("pageshow", onPageShow);
		return () => window.removeEventListener("pageshow", onPageShow);
	}, []);

	const handleUpgrade = async () => {
		if (!session?.user) {
			void navigate({ to: "/login" });
			return;
		}
		setUpgradeError("");
		setUpgrading(true);
		// Stripe Checkout へリダイレクトする。成功時は profile に戻り、
		// webhook 反映を待ってプレミアム表示になる。
		// 戻り先はプラグインが BETTER_AUTH_URL 基準で絶対URL化するため、
		// カスタムドメイン(wine.nibo.sh)やプレビューの別ホストから購入しても
		// 元のホストに戻れるよう、こちらで絶対URLにして渡す。
		const origin = window.location.origin;
		const result = await authClient.subscription.upgrade({
			plan: PREMIUM_PLAN_NAME,
			annual,
			successUrl: `${origin}/profile?checkout=success`,
			cancelUrl: `${origin}/pricing`,
		});
		if (result.error) {
			setUpgrading(false);
			setUpgradeError(
				result.error.message ?? "購入処理を開始できませんでした。",
			);
		}
		// 成功時はリダイレクトされるため何もしない
	};

	const priceLabel = annual
		? `¥${PREMIUM_PRICING.annualAmount.toLocaleString("ja-JP")}`
		: `¥${PREMIUM_PRICING.monthlyAmount.toLocaleString("ja-JP")}`;

	return (
		<main className="mx-auto max-w-4xl px-4 py-10">
			<div className="mb-8 text-center">
				<h1 className="text-3xl font-bold">料金プラン</h1>
				<p className="mt-2 text-muted-foreground">
					プレミアムプランで広告なしの快適な学習を。
				</p>
			</div>

			<div className="mb-8 flex items-center justify-center gap-3">
				<button
					type="button"
					onClick={() => setAnnual(false)}
					className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
						annual
							? "text-muted-foreground hover:text-foreground"
							: "bg-primary text-primary-foreground"
					}`}
				>
					月払い
				</button>
				<button
					type="button"
					onClick={() => setAnnual(true)}
					className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
						annual
							? "bg-primary text-primary-foreground"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					年払い
					<span className="ml-1.5 text-xs opacity-80">2ヶ月分お得</span>
				</button>
			</div>

			<div className="grid gap-6 sm:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>無料プラン</CardTitle>
						<p className="text-3xl font-bold">
							¥0
							<span className="ml-1 text-sm font-normal text-muted-foreground">
								/ ずっと無料
							</span>
						</p>
					</CardHeader>
					<CardContent>
						<ul className="flex flex-col gap-2 text-sm">
							{FREE_FEATURES.map((feature) => (
								<li key={feature} className="flex items-start gap-2">
									<CheckIcon
										className="mt-0.5 size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									{feature}
								</li>
							))}
						</ul>
					</CardContent>
					<CardFooter>
						<Button variant="outline" className="w-full" disabled>
							{isPremium ? "—" : "現在のプラン"}
						</Button>
					</CardFooter>
				</Card>

				<Card className="border-primary">
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							プレミアムプラン
							<span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
								おすすめ
							</span>
						</CardTitle>
						<p className="text-3xl font-bold">
							{priceLabel}
							<span className="ml-1 text-sm font-normal text-muted-foreground">
								/ {annual ? "年" : "月"}
							</span>
						</p>
						{annual && (
							<p className="text-sm text-muted-foreground">
								月額
								{PREMIUM_PRICING.monthlyAmount.toLocaleString("ja-JP")}
								円×10ヶ月分の料金で12ヶ月利用できます
							</p>
						)}
						<p className="text-sm font-medium text-primary">
							最初の{PREMIUM_TRIAL_DAYS}
							日間は無料。期間中に解約すれば料金はかかりません。
						</p>
					</CardHeader>
					<CardContent>
						<ul className="flex flex-col gap-2 text-sm">
							{PREMIUM_FEATURES.map((feature) => (
								<li key={feature} className="flex items-start gap-2">
									<CheckIcon
										className="mt-0.5 size-4 shrink-0 text-primary"
										aria-hidden
									/>
									{feature}
								</li>
							))}
						</ul>
						{upgradeError && (
							<p className="mt-3 text-sm text-destructive">{upgradeError}</p>
						)}
					</CardContent>
					<CardFooter className="flex-col gap-2">
						{isPremium ? (
							<>
								<Button variant="outline" className="w-full" disabled>
									現在のプラン
								</Button>
								<p className="text-center text-xs text-muted-foreground">
									プランの管理は
									<Link to="/profile" className="text-primary hover:underline">
										プロフィール
									</Link>
									から行えます
								</p>
							</>
						) : (
							<>
								<Button
									className="w-full"
									disabled={
										billingQuery.isPending || !stripeConfigured || upgrading
									}
									onClick={() => void handleUpgrade()}
								>
									{billingQuery.isPending
										? "読み込み中..."
										: upgrading
											? "手続きに進んでいます..."
											: session?.user
												? `${PREMIUM_TRIAL_DAYS}日間無料で始める`
												: "ログインして無料で始める"}
								</Button>
								{!stripeConfigured && (
									<p className="text-center text-xs text-muted-foreground">
										現在準備中です。もうしばらくお待ちください。
									</p>
								)}
							</>
						)}
					</CardFooter>
				</Card>
			</div>

			<p className="mt-8 text-center text-xs text-muted-foreground">
				最初の{PREMIUM_TRIAL_DAYS}
				日間は無料でお試しいただけます。入会手続きの画面でプロモーションコードを入力すると割引が適用されます。サブスクリプションはいつでも解約でき、解約後も期間終了までプレミアム特典をご利用いただけます。
			</p>
		</main>
	);
}
