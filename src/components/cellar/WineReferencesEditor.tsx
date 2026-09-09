import { useState } from "react";
import type { WineReferencesValue } from "#/components/cellar/drunk-wine-payload";
import { Button } from "#/components/ui/button";
import { FormField } from "#/components/ui/form-section";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { formatLabelPrice, labelPriceKey } from "#/lib/ai/label-extraction";
import {
	normalizeStoredMarketPrices,
	normalizeStoredReferenceLinks,
	STORED_MARKET_PRICES_MAX,
	STORED_REFERENCE_LINKS_MAX,
} from "#/lib/drunk-wine/references";
import { isHttpUrl } from "#/lib/reference-link/schema";

// 解析の参考サイト・市場価格の編集UI。銘柄に属する参考情報で、Web版フォーム
// (DrunkWineForm)が新規・編集の両方で使う。MCP App のフォームには載せない
// (保存経路の update ハンドラが参考情報を扱わないため。載せるのは別途)。
//
// 追加時の検証は正規化(サーバと同じ関門)で行い、残らなかった行は足さずに
// 理由を出す。サーバも再正規化するので、ここをすり抜けても保存は壊れない。

export interface WineReferencesEditorProps {
	value: WineReferencesValue;
	onChange: (next: WineReferencesValue) => void;
	/** 入力欄の DOM id の接頭辞(既定 "wine-references")。 */
	idPrefix?: string;
	/**
	 * 入力欄を出すかどうか(既定 true)。一覧だけ見せて追加はボタン式にするときは
	 * false にする(WineReferencesSection が出し分ける)。false でも削除はできる。
	 */
	showInputs?: boolean;
}

/** 市場価格の通貨の選択肢。JPY=円建て、それ以外は原通貨のまま保存する。 */
const PRICE_CURRENCIES = [
	{ id: "JPY", label: "円" },
	{ id: "USD", label: "$ (USD)" },
	{ id: "EUR", label: "€ (EUR)" },
	{ id: "GBP", label: "£ (GBP)" },
] as const;

export function WineReferencesEditor({
	value,
	onChange,
	idPrefix = "wine-references",
	showInputs = true,
}: WineReferencesEditorProps) {
	return (
		<div className="flex min-w-0 flex-col gap-6">
			<ReferenceLinksEditor
				links={value.referenceLinks}
				onChange={(referenceLinks) => onChange({ ...value, referenceLinks })}
				idPrefix={idPrefix}
				showInputs={showInputs}
			/>
			<MarketPricesEditor
				prices={value.prices}
				onChange={(prices) => onChange({ ...value, prices })}
				idPrefix={idPrefix}
				showInputs={showInputs}
			/>
		</div>
	);
}

function ReferenceLinksEditor({
	links,
	onChange,
	idPrefix,
	showInputs,
}: {
	links: WineReferencesValue["referenceLinks"];
	onChange: (next: WineReferencesValue["referenceLinks"]) => void;
	idPrefix: string;
	showInputs: boolean;
}) {
	const [title, setTitle] = useState("");
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");

	const add = () => {
		const trimmedUrl = url.trim();
		if (!trimmedUrl || !isHttpUrl(trimmedUrl)) {
			setError("http/https ではじまるURLを入力してください");
			return;
		}
		if (links.length >= STORED_REFERENCE_LINKS_MAX) {
			setError(`参考サイトは${STORED_REFERENCE_LINKS_MAX}件までです`);
			return;
		}
		const added = normalizeStoredReferenceLinks([
			{ title: title.trim() || undefined, url: trimmedUrl },
		]);
		if (added.length === 0) {
			setError("この内容では保存できません(タイトル・URLを確認してください)");
			return;
		}
		if (links.some((l) => l.url === added[0]?.url)) {
			setError("同じURLは既に登録されています");
			return;
		}
		onChange([...links, ...added]);
		setTitle("");
		setUrl("");
		setError("");
	};

	return (
		<FormField
			label="参考サイト"
			htmlFor={`${idPrefix}-link-url`}
			description="AIが裏取りに使ったページです。不要なものは削除できます"
		>
			<div className="flex min-w-0 flex-col gap-2">
				{links.length > 0 && (
					<ul className="flex min-w-0 flex-col gap-1.5">
						{links.map((link) => (
							// 長いタイトルでモバイルの横幅が広がらないよう li まで
							// min-w-0。a の truncate だけでは抑えきれないため。
							<li
								key={link.url}
								className="flex min-w-0 items-center gap-2 text-sm"
							>
								<a
									href={link.url}
									target="_blank"
									rel="noopener noreferrer nofollow"
									className="min-w-0 flex-1 truncate underline decoration-dotted underline-offset-2"
								>
									{link.title ?? link.url}
								</a>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="shrink-0"
									aria-label={`参考サイト「${link.title ?? link.url}」を削除`}
									onClick={() =>
										onChange(links.filter((l) => l.url !== link.url))
									}
								>
									削除
								</Button>
							</li>
						))}
					</ul>
				)}
				{showInputs && (
					<div className="flex min-w-0 flex-col gap-2">
						<Input
							id={`${idPrefix}-link-title`}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="タイトル(任意)"
							maxLength={200}
						/>
						<div className="flex min-w-0 gap-2">
							<Input
								id={`${idPrefix}-link-url`}
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="https://example.com/..."
								inputMode="url"
								className="flex-1"
							/>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="shrink-0"
								onClick={add}
							>
								追加
							</Button>
						</div>
					</div>
				)}
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				)}
			</div>
		</FormField>
	);
}

function MarketPricesEditor({
	prices,
	onChange,
	idPrefix,
	showInputs,
}: {
	prices: WineReferencesValue["prices"];
	onChange: (next: WineReferencesValue["prices"]) => void;
	idPrefix: string;
	showInputs: boolean;
}) {
	const [source, setSource] = useState("");
	const [amount, setAmount] = useState("");
	const [currency, setCurrency] = useState<string>("JPY");
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");

	const add = () => {
		const trimmedSource = source.trim();
		if (!trimmedSource) {
			setError("店・サイト名を入力してください");
			return;
		}
		const n = Number(amount.replace(/,/g, ""));
		if (!Number.isFinite(n) || n <= 0) {
			setError("金額を入力してください");
			return;
		}
		const trimmedUrl = url.trim();
		if (trimmedUrl && !isHttpUrl(trimmedUrl)) {
			setError("URLはhttp/httpsではじまるものだけ対応しています");
			return;
		}
		if (prices.length >= STORED_MARKET_PRICES_MAX) {
			setError(`価格は${STORED_MARKET_PRICES_MAX}件までです`);
			return;
		}
		const added = normalizeStoredMarketPrices([
			{
				source: trimmedSource,
				...(currency === "JPY"
					? { amountJpy: Math.trunc(n) }
					: { currency, amount: Math.round(n * 100) / 100 }),
				...(trimmedUrl ? { url: trimmedUrl } : {}),
			},
		]);
		if (added.length === 0) {
			setError("この内容では保存できません(金額を確認してください)");
			return;
		}
		onChange([...prices, ...added]);
		setSource("");
		setAmount("");
		setUrl("");
		setError("");
	};

	return (
		<FormField
			label="市場価格"
			htmlFor={`${idPrefix}-price-source`}
			description="AIが見つけた販売価格です。不要なものは削除できます"
		>
			<div className="flex min-w-0 flex-col gap-2">
				{prices.length > 0 && (
					<ul className="flex min-w-0 flex-col gap-1.5">
						{prices.map((price) => {
							const line = `${formatLabelPrice(price)}(${price.source})`;
							const key = labelPriceKey(price);
							return (
								// 長い店名で横に広がらないよう min-w-0 + 折り返し。
								<li
									key={key}
									className="flex min-w-0 items-center gap-2 text-sm"
								>
									<span className="min-w-0 flex-1 break-words">{line}</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="shrink-0"
										aria-label={`価格「${line}」を削除`}
										onClick={() =>
											onChange(prices.filter((p) => labelPriceKey(p) !== key))
										}
									>
										削除
									</Button>
								</li>
							);
						})}
					</ul>
				)}
				{showInputs && (
					<div className="flex min-w-0 flex-col gap-2">
						<Input
							id={`${idPrefix}-price-source`}
							value={source}
							onChange={(e) => setSource(e.target.value)}
							placeholder="店・サイト名(例: ドメイン名)"
							maxLength={100}
						/>
						<div className="flex min-w-0 gap-2">
							<Input
								id={`${idPrefix}-price-amount`}
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								placeholder="金額(例: 2000)"
								inputMode="decimal"
								className="flex-1"
							/>
							<Select value={currency} onValueChange={setCurrency}>
								<SelectTrigger
									id={`${idPrefix}-price-currency`}
									className="w-28 shrink-0"
									aria-label="通貨"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PRICE_CURRENCIES.map((c) => (
										<SelectItem key={c.id} value={c.id}>
											{c.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="shrink-0"
								onClick={add}
							>
								追加
							</Button>
						</div>
						<Input
							id={`${idPrefix}-price-url`}
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="価格を見たページのURL(任意)"
							inputMode="url"
						/>
					</div>
				)}
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				)}
			</div>
		</FormField>
	);
}
