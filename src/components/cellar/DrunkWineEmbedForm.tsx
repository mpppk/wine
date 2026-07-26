import { useMemo, useState } from "react";
import { DrunkWineFields } from "#/components/cellar/DrunkWineFields";
import {
	buildMcpTastingArgs,
	buildMcpUpdatePatch,
	type DrunkWineFieldsValue,
	fieldsValueFromMcpEntry,
	tastingDraftFromMcpEntry,
	type WineTastingDraft,
} from "#/components/cellar/drunk-wine-payload";
import { TastingFields } from "#/components/cellar/TastingFields";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import type { DrunkWinePatch } from "#/lib/drunk-wine/fields";
import { hasDrunkWinePatch } from "#/lib/drunk-wine/fields";
import type { ReceivedDrunkWineEntry } from "#/lib/mcp-app/entry";
import { cn } from "#/lib/utils";

export interface EmbedSaveStatus {
	text: string;
	kind: "ok" | "error";
}

export interface DrunkWineEmbedFormProps {
	/** ホストから届いたエントリ。差分パッチの基準にもなる。 */
	entry: ReceivedDrunkWineEntry;
	/** 自オリジンのベースURL。写真URLの検証に使う。 */
	baseUrl: string;
	/** 変更があったときだけ呼ばれる(snake_case の差分パッチ)。 */
	onSave: (patch: DrunkWinePatch) => void;
	saving?: boolean;
	status?: EmbedSaveStatus | null;
	/** 変更が無い状態で保存が押された。 */
	onNoChanges?: () => void;
}

/**
 * ホストから受け取った写真を描画する。postMessage 経由の値なので、自オリジンの
 * URLだけを描画する。"https://host.evil.example" のような前方一致での偽装を
 * 防ぐため origin を厳密比較し、1件の不正URLで全滅しないようURLごとに検証する。
 */
function photoSources(
	entry: ReceivedDrunkWineEntry,
	baseUrl: string,
): string[] {
	const urls =
		Array.isArray(entry.photo_urls) && entry.photo_urls.length > 0
			? entry.photo_urls
			: entry.photo_url
				? [entry.photo_url]
				: [];
	const sources: string[] = [];
	for (const url of urls) {
		if (typeof url !== "string") continue;
		try {
			const resolved = new URL(url, baseUrl);
			if (resolved.origin === new URL(baseUrl).origin) {
				sources.push(resolved.toString());
			}
		} catch {
			// 不正なURLは飛ばす
		}
	}
	return sources;
}

/**
 * MCP App(ホストのサンドボックス iframe)で描画する編集フォーム。
 *
 * Web版と同じ DrunkWineFields を使い、保存だけをホスト仲介の tools/call に
 * 委ねる(onSave)。このコンポーネント自体は認証情報にも window にも触らない
 * ので、ホストとのやり取り抜きに単体テストできる。
 */
export function DrunkWineEmbedForm({
	entry,
	baseUrl,
	onSave,
	saving = false,
	status = null,
	onNoChanges,
}: DrunkWineEmbedFormProps) {
	// 入力値は初回マウント時のエントリからのみ作る。保存応答で entry(差分の基準)が
	// 更新されてもフォームは作り直さない: 応答待ちの間(特にタイムアウト後の遅延応答)に
	// ユーザが入力した内容を捨てないため。別エントリの表示に切り替わるときは
	// 呼び出し側が key={entry.id} で作り直す。
	const [values, setValues] = useState<DrunkWineFieldsValue>(() =>
		fieldsValueFromMcpEntry(entry),
	);
	// 飲用記録は 1:N だが、ホストから届くのは最新1件の射影なので、この画面では
	// その1件だけを編集する(update_drunk_wine のレガシー引数が最新1件を更新する)。
	// 別の日に飲んだ記録の追加は add_wine_tasting ツールの担当。
	const [tastingDraft, setTastingDraft] = useState<WineTastingDraft>(() =>
		tastingDraftFromMcpEntry(entry),
	);

	const photos = useMemo(() => photoSources(entry, baseUrl), [entry, baseUrl]);

	const save = () => {
		const patch = buildMcpUpdatePatch(entry, values);
		const tastingArgs = buildMcpTastingArgs(entry, tastingDraft);
		const merged = { ...patch, ...tastingArgs };
		if (!hasDrunkWinePatch(merged)) {
			onNoChanges?.();
			return;
		}
		onSave(merged);
	};

	return (
		<div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
			<div className="flex flex-col gap-1">
				<h1 className="text-base font-semibold">
					{values.name || "飲んだワイン"}
				</h1>
				<p className="text-xs text-muted-foreground">
					マイセラーに記録しました。内容はこのまま編集できます。
				</p>
			</div>

			{photos.length > 0 && (
				<ul className="flex flex-wrap gap-3">
					{photos.map((src, index) => (
						<li key={src}>
							<img
								src={src}
								alt={index === 0 ? "代表写真" : `写真${index + 1}`}
								className="max-h-52 max-w-full rounded-md border border-border"
							/>
						</li>
					))}
				</ul>
			)}

			<DrunkWineFields
				value={values}
				onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
				tastingSlot={
					<fieldset className="flex flex-col gap-4">
						<Label asChild>
							<legend>最新の飲んだ記録</legend>
						</Label>
						<TastingFields
							value={tastingDraft}
							onChange={(patch) =>
								setTastingDraft((prev) => ({ ...prev, ...patch }))
							}
							idPrefix="embed-tasting"
							disabled={saving}
						/>
					</fieldset>
				}
			/>

			<div className="flex items-center gap-3">
				{/* ホストのサンドボックスでは allow-forms が付かないことがあるため、
				    submit ではなく click で保存する */}
				<Button
					type="button"
					onClick={save}
					disabled={saving || !values.name.trim()}
					className="self-start"
				>
					{saving ? "保存中..." : "保存"}
				</Button>
				{status && (
					<p
						className={cn(
							"text-sm",
							status.kind === "error" ? "text-destructive" : "text-emerald-600",
						)}
					>
						{status.text}
					</p>
				)}
			</div>
		</div>
	);
}
