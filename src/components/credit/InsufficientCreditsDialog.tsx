import { Link } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "#/components/ui/dialog";
import { PREMIUM_PRICING } from "#/lib/billing/plans";

// AIクレジットの残高不足でブロックしたときに出すアップグレード誘導。追加購入・繰越は
// 現状無いため、次月の付与を待つかプレミアムへの案内に一本化する。
export function InsufficientCreditsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<div className="flex flex-col items-center gap-4 py-4 text-center">
					<SparklesIcon className="size-10 text-primary" aria-hidden />
					<DialogTitle className="text-xl">
						今月のAIクレジットを使い切りました
					</DialogTitle>
					<DialogDescription className="max-w-xs">
						クレジットは毎月付与されます。プレミアムプラン(月額
						{PREMIUM_PRICING.monthlyAmount.toLocaleString("ja-JP")}
						円)なら、毎月より多くのクレジットが付与されます。
					</DialogDescription>
				</div>
				<DialogFooter className="sm:flex-col sm:gap-2">
					<Button asChild className="w-full">
						<Link to="/pricing">プレミアムプランを見る</Link>
					</Button>
					<Button
						variant="ghost"
						className="w-full"
						onClick={() => onOpenChange(false)}
					>
						閉じる
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
