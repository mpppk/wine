import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MapIcon, PlayIcon, WineIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { STARTER_REGION_ID } from "#/lib/dashboard/recommend";
import { dismissWelcome } from "#/lib/dashboard/welcome";
import { cn } from "#/lib/utils";
import { getRegion } from "#/lib/wine/service";

export const Route = createFileRoute("/welcome")({
	component: WelcomePage,
});

// サインアップ直後の専有画面で一度だけ伝える3枚。訴求軸は「ワインを理解する
// 楽しさ」に統一し、試験(ワインエキスパート等)の文脈は使わない(#206)。
// 本文は StarterGuide.tsx の3ステップと対応させるが、こちらは「なぜやるのか」
// の説明に徹し、操作の導線はダッシュボードのガイドに任せて重複を避ける。

interface WelcomeStep {
	icon: typeof MapIcon;
	heading: string;
	body: string;
}

const STEPS: readonly WelcomeStep[] = [
	{
		icon: MapIcon,
		heading: "ワインは地図から覚えよう",
		body: "このアプリの学び方は3つだけです。地図で産地を眺める、クイズで定着させる、飲んだ1本・気になった1本を記録する。まずは眺めることから始めましょう。",
	},
	{
		icon: PlayIcon,
		heading: "位置関係が分かると味がつながる",
		body: "隣り合う村や畑が分かると、「なぜこの2本は似ていて、あの1本は違うのか」が見えてきます。クイズで位置を思い出すたびに、飲んだときの味の記憶とつながります。",
	},
	{
		icon: WineIcon,
		heading: "まずはブルゴーニュから",
		body: "畑(クリマ)ごとの違いがそのまま味の違いになる地域です。地図で区画を眺める学び方をいちばん体感しやすいので、最初の1枚に選びました。",
	},
];

function WelcomePage() {
	const navigate = useNavigate();
	const [index, setIndex] = useState(0);
	const step = STEPS[index];
	const isLast = index === STEPS.length - 1;
	const regionName = getRegion(STARTER_REGION_ID)?.nameJa ?? "";

	const skip = () => {
		dismissWelcome();
		void navigate({ to: "/" });
	};
	const finishToMap = () => {
		dismissWelcome();
	};

	if (!step) return null;
	const { icon: Icon } = step;

	return (
		<main className="mx-auto flex min-h-[calc(100vh-57px)] max-w-md flex-col justify-center px-4 py-10">
			<Card>
				<CardContent className="flex flex-col gap-5">
					<div className="flex items-center justify-between">
						<div
							className="flex gap-1.5"
							role="img"
							aria-label={`${STEPS.length}枚中${index + 1}枚目`}
						>
							{STEPS.map((s, i) => (
								<span
									key={s.heading}
									aria-hidden
									className={cn(
										"h-1.5 w-8 rounded-full",
										i === index ? "bg-primary" : "bg-muted",
									)}
								/>
							))}
						</div>
						<Button type="button" variant="ghost" size="sm" onClick={skip}>
							スキップ
						</Button>
					</div>

					<div className="flex flex-col items-center gap-3 text-center">
						<span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
							<Icon className="size-7" aria-hidden />
						</span>
						<h1 className="text-xl font-semibold">{step.heading}</h1>
						<p className="text-sm leading-relaxed text-muted-foreground">
							{step.body}
						</p>
					</div>

					<div className="flex items-center justify-between gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={index === 0}
							onClick={() => setIndex((i) => Math.max(0, i - 1))}
						>
							もどる
						</Button>
						{isLast ? (
							<Button asChild onClick={finishToMap}>
								<Link
									to="/map/$regionId"
									params={{ regionId: STARTER_REGION_ID }}
								>
									<MapIcon className="size-4" aria-hidden />
									{regionName ? `${regionName}の地図を開く` : "地図を開く"}
								</Link>
							</Button>
						) : (
							<Button
								type="button"
								onClick={() =>
									setIndex((i) => Math.min(STEPS.length - 1, i + 1))
								}
							>
								つぎへ
							</Button>
						)}
					</div>
				</CardContent>
			</Card>
		</main>
	);
}
