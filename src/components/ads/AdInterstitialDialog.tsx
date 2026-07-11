import { Link } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";
import { shouldShowQuizAd } from "#/lib/ads/placement";
import { PREMIUM_PRICING } from "#/lib/billing/plans";
import { useShowAds } from "#/lib/billing/use-billing";

// クイズで10問回答ごとに挟む全画面ハウス広告(現状はプレミアム訴求のみ)。
// 強制待機はさせない方針: 閉じる操作(×・ESC・オーバーレイ・「続ける」)は
// すべて「次の問題へ進む」として扱う。

/**
 * クイズの「次へ」に広告を割り込ませるフック。
 * - answered が10の倍数のとき、next() の代わりにインタースティシャルを開く
 * - 広告が閉じられたタイミングで next() を実行して出題を再開する
 * - プレミアム会員・embed配下などでは useShowAds が false になり素通しする
 */
export function useQuizAdInterstitial(answered: number, next: () => void) {
	const showAds = useShowAds();
	const [adOpen, setAdOpen] = useState(false);

	const nextWithAd = useCallback(() => {
		if (showAds && shouldShowQuizAd(answered)) {
			setAdOpen(true);
			return;
		}
		next();
	}, [showAds, answered, next]);

	const onAdOpenChange = useCallback(
		(open: boolean) => {
			if (open) return;
			setAdOpen(false);
			next();
		},
		[next],
	);

	return { adOpen, onAdOpenChange, nextWithAd };
}

export function AdInterstitialDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="top-0 left-0 flex h-dvh max-w-full translate-x-0 translate-y-0 flex-col rounded-none border-0 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-w-md sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border">
				<span className="self-start rounded border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
					広告
				</span>
				<div className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center sm:py-4">
					<SparklesIcon className="size-10 text-primary" aria-hidden />
					<DialogTitle className="text-xl">
						広告なしで集中して学習しませんか？
					</DialogTitle>
					<DialogDescription className="max-w-xs">
						プレミアムプラン(月額
						{PREMIUM_PRICING.monthlyAmount.toLocaleString("ja-JP")}
						円)なら、この広告を含むすべての広告が非表示になります。
					</DialogDescription>
					<Button asChild variant="outline">
						<Link to="/pricing">プレミアムプランを見る</Link>
					</Button>
				</div>
				<Button
					size="lg"
					className="h-14 w-full text-base"
					onClick={() => onOpenChange(false)}
				>
					クイズを続ける
				</Button>
			</DialogContent>
		</Dialog>
	);
}
