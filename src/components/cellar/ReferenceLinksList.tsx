import { ExternalLinkIcon, LinkIcon, TagIcon } from "lucide-react";
import type { LabelPrice, LabelReferenceLink } from "#/lib/ai/label-extraction";

// 解析結果の参考サイト・価格の表示。**カードの展開部と差分ダイアログ(将来は
// ワイン詳細)が共有する**——表示仕様を経路ごとに書くと、MCP App フォームの
// photo_urls 対応漏れ(#185)と同じドリフトが起きる。
//
// 空配列のときは何も描かない(呼び出し側で有無を気にしなくてよい)。

/** 参考サイトの一覧。外部リンクは新規タブ + `rel="noreferrer"` で開く。 */
export function ReferenceLinksList({ links }: { links: LabelReferenceLink[] }) {
	if (links.length === 0) return null;
	return (
		<section aria-label="参考サイト">
			<h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground">
				<LinkIcon className="size-3.5" aria-hidden />
				参考サイト
			</h4>
			<ul className="flex flex-col gap-1.5">
				{links.map((link) => (
					<li key={link.url}>
						<a
							href={link.url}
							target="_blank"
							rel="noopener noreferrer nofollow"
							title={link.url}
							className="flex min-w-0 items-center gap-1 text-sm underline decoration-dotted underline-offset-2 hover:text-foreground"
						>
							<span className="truncate">{link.title ?? link.url}</span>
							<ExternalLinkIcon
								className="size-3 shrink-0 opacity-60"
								aria-hidden
							/>
						</a>
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * 複数ソースの価格一覧。1行は「aaa.comでは2,000円」の形。
 * 価格を見たページのURLがあれば行ごとリンクにする。
 */
export function PriceList({ prices }: { prices: LabelPrice[] }) {
	if (prices.length === 0) return null;
	return (
		<section aria-label="価格一覧">
			<h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground">
				<TagIcon className="size-3.5" aria-hidden />
				価格一覧
			</h4>
			<ul className="flex flex-col gap-1.5 text-sm">
				{prices.map((price) => {
					const amount =
						price.amountJpy != null
							? `${price.amountJpy.toLocaleString("ja-JP")}円`
							: "価格不明";
					const line = `${price.source}では${amount}`;
					return (
						<li key={`${price.source}|${price.amountJpy ?? ""}`}>
							{price.url ? (
								<a
									href={price.url}
									target="_blank"
									rel="noopener noreferrer nofollow"
									title={price.url}
									className="underline decoration-dotted underline-offset-2 hover:text-foreground"
								>
									{line}
									<ExternalLinkIcon
										className="ml-1 inline size-3 opacity-60"
										aria-hidden
									/>
								</a>
							) : (
								<span>{line}</span>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
