import { Link } from "@tanstack/react-router";
import { CheckIcon, MapIcon, PlayIcon, WineIcon, XIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { dismissStarterGuide } from "#/lib/dashboard/guide-dismissal";
import {
	buildStarterSteps,
	type StarterStepId,
} from "#/lib/dashboard/onboarding";
import { cn } from "#/lib/utils";
import { getRegion } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";

// 新規ユーザ向けの「おすすめの使い方」ガイド。何から始めればよいかを3ステップで示し、
// 済んだステップにはチェックを付けて進捗が見えるようにする。表示するかどうかの判定は
// #/lib/dashboard/onboarding の純関数が持ち、ここは描画に徹する。

/** ステップごとの見出し・説明・遷移先。説明は「なぜやるのか」を1行で書く */
const STEP_COPY: Record<
	StarterStepId,
	{ icon: typeof MapIcon; title: string; cta: string }
> = {
	map: { icon: MapIcon, title: "地図で産地を眺める", cta: "地図を開く" },
	quiz: { icon: PlayIcon, title: "クイズで覚える", cta: "クイズを始める" },
	cellar: {
		icon: WineIcon,
		title: "飲んだワインを記録する",
		cta: "セラーに登録する",
	},
};

export function StarterGuide({
	regionId,
	seen,
	cellarCount,
}: {
	/** おすすめの地域。地図・クイズの遷移先と学習の着目点に使う */
	regionId: RegionId | null;
	seen: number;
	cellarCount: number;
}) {
	const steps = buildStarterSteps({ seen, cellarCount });
	const regionName =
		regionId != null ? (getRegion(regionId)?.nameJa ?? "") : "";

	// ステップごとの説明文。「なぜやるのか」を1行で書く。
	// 地域ごとの着目点(learningFocus)は直下のおすすめ枠が出すのでここでは繰り返さない
	// (「閉じる」はCSS側の判定なので、ガイドの表示有無で他の要素を出し分けられない)。
	const detailOf = (id: StarterStepId): string => {
		if (id === "map") {
			return regionName
				? `${regionName}の地図で、村や畑の位置関係をつかみます。`
				: "地図で産地の位置関係をつかみます。";
		}
		if (id === "quiz") {
			return regionName
				? `${regionName}の4択クイズで、眺めた産地を記憶に定着させます。`
				: "4択クイズで、眺めた産地を記憶に定着させます。";
		}
		return "飲んだ1本を記録すると、覚えた知識と実際の味わいがつながります。";
	};

	return (
		<Card
			data-starter-guide
			className="border-primary/40 bg-primary/5"
			aria-labelledby="starter-guide-heading"
		>
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-start justify-between gap-2">
					<div>
						<p id="starter-guide-heading" className="text-lg font-semibold">
							ようこそ。まずはこの3ステップから
						</p>
						<p className="mt-1 text-sm text-muted-foreground">
							地図で眺めて、クイズで覚えて、飲んだ1本を記録する。これがこのアプリの
							おすすめの使い方です。
						</p>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="-mr-2 -mt-1 shrink-0"
						onClick={dismissStarterGuide}
						aria-label="ガイドを閉じる"
						title="ガイドを閉じる"
					>
						<XIcon className="size-4" aria-hidden />
					</Button>
				</div>

				<ol className="flex flex-col gap-3">
					{steps.map((step, index) => {
						const { title, cta } = STEP_COPY[step.id];
						const done = step.done === true;
						return (
							<li
								key={step.id}
								className={cn(
									"flex flex-col gap-2 rounded-xl border bg-background p-3",
									done && "opacity-60",
								)}
							>
								<div className="flex items-center gap-2">
									<span
										className={cn(
											"flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
											done
												? "bg-green-500 text-white"
												: "bg-primary/10 text-primary",
										)}
										aria-hidden
									>
										{done ? <CheckIcon className="size-4" /> : index + 1}
									</span>
									<span className="font-medium">{title}</span>
									{done && (
										<span className="text-xs text-muted-foreground">完了</span>
									)}
								</div>
								<p className="text-sm leading-relaxed text-muted-foreground">
									{detailOf(step.id)}
								</p>
								{!done && (
									<div>
										<StepAction id={step.id} regionId={regionId} label={cta} />
									</div>
								)}
							</li>
						);
					})}
				</ol>
			</CardContent>
		</Card>
	);
}

function StepAction({
	id,
	regionId,
	label,
}: {
	id: StarterStepId;
	regionId: RegionId | null;
	label: string;
}) {
	const { icon: Icon } = STEP_COPY[id];
	const content = (
		<>
			<Icon className="size-4" aria-hidden />
			{label}
		</>
	);

	if (id === "cellar") {
		return (
			<Button asChild size="sm">
				<Link to="/cellar/new">{content}</Link>
			</Button>
		);
	}

	// 地図・クイズはおすすめ地域へ直行する。地域が決まらない異常系(出題可能な地域が
	// 無い場合)だけ、地域選択画面にフォールバックする。
	if (regionId == null) {
		return (
			<Button asChild size="sm">
				<Link to="/regions">{content}</Link>
			</Button>
		);
	}

	if (id === "map") {
		return (
			<Button asChild size="sm">
				<Link to="/map/$regionId" params={{ regionId }}>
					{content}
				</Link>
			</Button>
		);
	}

	return (
		<Button asChild size="sm">
			<Link to="/quiz/play" search={{ region: regionId, types: undefined }}>
				{content}
			</Link>
		</Button>
	);
}
