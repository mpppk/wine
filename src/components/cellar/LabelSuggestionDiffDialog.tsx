import { useState } from "react";
import type { LabelDiffItem } from "#/components/cellar/label-suggestion-diff";
import {
	PriceList,
	ReferenceLinksList,
} from "#/components/cellar/ReferenceLinksList";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import type { LabelPrice, LabelReferenceLink } from "#/lib/ai/label-extraction";

export interface LabelSuggestionDiffDialogProps {
	open: boolean;
	diffs: LabelDiffItem[];
	/** チェックされた項目のpatchをマージして反映する */
	onApply: (selected: LabelDiffItem[]) => void;
	onOpenChange: (open: boolean) => void;
	/**
	 * 解析結果の参考サイト・価格(IMPL-3)。**選択対象ではなく参考表示**——
	 * フォーム項目では無いので差分には載せず、カードの展開部と同じ
	 * 共通コンポーネントで一覧の下に出す。
	 */
	references?: {
		referenceLinks?: LabelReferenceLink[];
		prices?: LabelPrice[];
	};
}

/**
 * エチケット解析の結果と現在の入力の差分を一覧で提示し、反映する項目を
 * ユーザに選ばせるダイアログ(#362)。「未入力の項目にしか反映しない」自動適用は
 * 再解析(写真追加・エンジン切替)の結果が伝わらずクレジットだけ消費される事故に
 * つながるため、上書き事故の防止をユーザの選択制に置き換える。
 */
export function LabelSuggestionDiffDialog({
	open,
	diffs,
	onApply,
	onOpenChange,
	references,
}: LabelSuggestionDiffDialogProps) {
	// key は "region" 等の固定文字列なので Set<LabelDiffItem["key"]> で足りる。
	// diffs は open=false のまま維持される(Dialogがアンマウントされない)ため、
	// useState の初期化関数は初回の1回しか走らない。再解析で新しい diffs が来る
	// たびに全選択へ戻すには、レンダー中に diffs の参照変化を検知して同期する
	// (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)。
	const [prevDiffs, setPrevDiffs] = useState(diffs);
	const [selected, setSelected] = useState<Set<LabelDiffItem["key"]>>(
		() => new Set(diffs.map((d) => d.key)),
	);
	if (diffs !== prevDiffs) {
		setPrevDiffs(diffs);
		setSelected(new Set(diffs.map((d) => d.key)));
	}
	const toggle = (key: LabelDiffItem["key"]) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>今回の解析結果と現在の入力に差分があります</DialogTitle>
					<DialogDescription>
						反映する項目を選んでください(選ばなかった項目は変更されません)。
					</DialogDescription>
				</DialogHeader>
				<ul className="flex flex-col gap-3">
					{diffs.map((d) => (
						<li key={d.key} className="flex items-start gap-3">
							<Checkbox
								id={`label-diff-${d.key}`}
								checked={selected.has(d.key)}
								onCheckedChange={() => toggle(d.key)}
								className="mt-1"
							/>
							<label
								htmlFor={`label-diff-${d.key}`}
								className="flex flex-1 flex-col gap-0.5 text-sm"
							>
								<span className="font-medium">{d.label}</span>
								<span className="text-muted-foreground">
									{d.current} → {d.suggested}
								</span>
							</label>
						</li>
					))}
				</ul>
				{(references?.referenceLinks?.length ?? 0) > 0 && (
					<ReferenceLinksList links={references?.referenceLinks ?? []} />
				)}
				{(references?.prices?.length ?? 0) > 0 && (
					<PriceList prices={references?.prices ?? []} />
				)}
				<DialogFooter className="sm:flex-col-reverse sm:gap-2">
					<Button
						type="button"
						variant="outline"
						className="w-full"
						onClick={() => onOpenChange(false)}
					>
						そのままにする
					</Button>
					<Button
						type="button"
						className="w-full"
						disabled={selected.size === 0}
						onClick={() => onApply(diffs.filter((d) => selected.has(d.key)))}
					>
						選んだ項目を反映
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
