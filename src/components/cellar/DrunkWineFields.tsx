import type React from "react";
import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import { GrapeVarietyMultiSelect } from "#/components/cellar/GrapeVarietyMultiSelect";
import { ProvenancePicker } from "#/components/cellar/ProvenancePicker";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { WINE_STATUSES, type WineStatus } from "#/lib/drunk-wine/status";

export interface DrunkWineFieldsProps {
	value: DrunkWineFieldsValue;
	/** 変更のあったキーだけを渡す。呼び出し側が state にマージする。 */
	onChange: (patch: Partial<DrunkWineFieldsValue>) => void;
	/**
	 * ぶどう品種の後に差し込む写真UI。Web版フォームだけが渡す
	 * (写真の追加・削除は認証必須の /api/wine-photos を叩くため、
	 * 無認証で動く MCP App のフォームからは操作できない)。
	 */
	photoSlot?: React.ReactNode;
	/**
	 * 末尾に差し込む飲用記録UI。Web版フォームだけが渡す(新規作成なら1件ぶんの
	 * 入力、編集なら記録一覧)。MCP App は保存経路が update_drunk_wine の
	 * レガシー引数なので、自前で TastingFields を描画する。
	 */
	tastingSlot?: React.ReactNode;
	/**
	 * 入力欄の DOM id の接頭辞(既定 "wine")。**同じ画面にこのフォームを複数置く
	 * 場合は必ずカードごとに変える**。一括登録のレビュー画面(/cellar/import)は
	 * 銘柄の数だけこのフォームを描画するため、固定 id のままだと label の
	 * htmlFor が全部先頭のカードを指し、2枚目以降のラベルを押しても別のカードの
	 * 入力欄にフォーカスが飛ぶ。TastingFields の idPrefix と同じ流儀。
	 */
	idPrefix?: string;
}

/**
 * マイセラーの銘柄(ボトル)の入力項目一式。Web版フォーム(DrunkWineForm)と
 * MCP App のフォーム(/embed/drunk-wine)で共有する表示層。
 *
 * 飲んだ日・評価・メモはここに無い。飲用記録(1:N)へ移したため(Issue #195)、
 * TastingFields が担当する。
 *
 * 以前は MCP App 側が apps.ts のテンプレート文字列内 vanilla JS で同じフォームを
 * 別実装しており、photo_urls 非対応などのドリフトが起きていた(#155/#189)。
 * 表示の単一情報源をこのコンポーネントに寄せ、保存経路の違い(server fn か
 * ホスト仲介の tools/call か)だけを呼び出し側が持つ。
 *
 * <form> は含めない。MCP App はホストのサンドボックス iframe(allow-forms が
 * 付かないことがある)の中で動くため、保存は submit ではなくボタンの onClick で
 * 行う必要がある。
 */
export function DrunkWineFields({
	value,
	onChange,
	photoSlot,
	tastingSlot,
	idPrefix = "wine",
}: DrunkWineFieldsProps) {
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-name`}>
					名前 <span className="text-destructive">*</span>
				</Label>
				<Input
					id={`${idPrefix}-name`}
					type="text"
					value={value.name}
					onChange={(e) => onChange({ name: e.target.value })}
					placeholder="例: シャブリ プルミエ・クリュ"
					maxLength={200}
					required
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-status`}>状態</Label>
				<Select
					value={value.status}
					onValueChange={(v) => onChange({ status: v as WineStatus })}
				>
					<SelectTrigger id={`${idPrefix}-status`} className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{WINE_STATUSES.map((s) => (
							<SelectItem key={s.id} value={s.id}>
								{s.labelJa}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-xs text-muted-foreground">
					{WINE_STATUSES.find((s) => s.id === value.status)?.descriptionJa}
				</p>
			</div>

			<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-vintage`}>ヴィンテージ</Label>
					<Input
						id={`${idPrefix}-vintage`}
						type="number"
						min={1800}
						max={2100}
						value={value.vintage}
						onChange={(e) => onChange({ vintage: e.target.value })}
						placeholder="例: 2020"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-producer`}>生産者</Label>
					<Input
						id={`${idPrefix}-producer`}
						type="text"
						value={value.producer}
						onChange={(e) => onChange({ producer: e.target.value })}
						placeholder="例: ドメーヌ・ルフレーヴ"
						maxLength={200}
					/>
				</div>

				{/*
				 * 未購入(wishlist)では価格を出さない。state は消さずに描画だけ止める:
				 * 空文字にすると差分パッチが price: null(クリア)を送り、買った後に
				 * 状態を戻したときへ既存の価格が失われる。
				 */}
				{value.status !== "wishlist" && (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${idPrefix}-price`}>価格(円)</Label>
						<Input
							id={`${idPrefix}-price`}
							type="number"
							min={0}
							max={10_000_000}
							value={value.price}
							onChange={(e) => onChange({ price: e.target.value })}
							placeholder="例: 5000"
						/>
					</div>
				)}
			</div>

			<fieldset className="flex flex-col gap-3">
				<Label asChild>
					<legend>産地紐付け(任意)</legend>
				</Label>
				<p className="-mt-2 text-xs text-muted-foreground">
					AOP(村・畑・クリマ)まで特定できる場合はその単位で、分からない場合は地域や国だけでも紐付けられます。
				</p>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<ProvenancePicker
						value={{
							aopId: value.aopId,
							regionId: value.regionId,
							countryId: value.countryId,
						}}
						onChange={onChange}
					/>
				</div>
			</fieldset>

			<fieldset className="flex flex-col gap-3">
				<Label asChild>
					<legend>ぶどう品種(複数選択可)</legend>
				</Label>
				<GrapeVarietyMultiSelect
					value={value.grapeVarietyIds}
					onChange={(ids) => onChange({ grapeVarietyIds: ids })}
				/>
			</fieldset>

			{photoSlot}

			{tastingSlot}
		</>
	);
}
