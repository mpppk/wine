import { Link } from "@tanstack/react-router";
import { CoinsIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useCreditBalance } from "#/lib/credit/use-credit";

// Header に置くAIクレジット残高のピル。ログイン済みで残高が取れたときだけ表示する。
// 取得中・取得失敗・未ログインは null(残高0の誤表示やフラッシュを避ける)。
// Header 自体が /embed 配下で null を返すため、埋め込みビューでは自動的に出ない。
export function CreditBalanceIndicator() {
	const { data, isPending, isError } = useCreditBalance();
	if (isPending || isError || !data?.authenticated || data.balance === null) {
		return null;
	}

	return (
		<Button
			asChild
			variant="outline"
			size="sm"
			title="AIクレジット残高"
			aria-label={`AIクレジット残高 ${data.balance}`}
		>
			<Link to="/profile">
				<CoinsIcon className="size-4 text-primary" aria-hidden />
				<span className="tabular-nums font-medium">
					{data.balance.toLocaleString("ja-JP")}
				</span>
			</Link>
		</Button>
	);
}
