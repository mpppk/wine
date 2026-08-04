import type React from "react";
import { Label } from "#/components/ui/label";
import { cn } from "#/lib/utils";

/**
 * 見出しと本文の間隔(6px)。単独の入力欄(FormField)と見出し付きセクション
 * (FormSection)で同じ値を使い、画面全体で「見出し→中身」の距離を揃える。
 *
 * FormSection 側が margin(`mt-1.5`)、FormField 側が gap(`gap-1.5`)なのは
 * legend の描画の都合(FormSection のコメント参照)。値は同じ 0.375rem。
 */
const HEADING_GAP = "mt-1.5";

/** セクション本文の要素同士の間隔(12px)。説明文と入力UIの間もこれ。 */
const CONTENT_GAP = "gap-3";

export interface FormFieldProps {
	/** 入力欄の見出し */
	label: React.ReactNode;
	/** 見出しが指す入力欄の id。指定すると label 押下でフォーカスが移る */
	htmlFor?: string;
	/** 必須マーク(*)を出す。入力欄側の required 属性は呼び出し側で付ける */
	required?: boolean;
	/** 入力欄の下に出す補足文 */
	description?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}

/**
 * 見出し(Label)付きの入力欄1つぶん。**見出しと中身の間隔をここでしか作らない**。
 *
 * 同じ `flex flex-col gap-1.5` を各所に書くと、後から足した欄だけ間隔がずれる
 * (実際に記録画面では 6px / 12px / 16px / 重なり が混在していた)。
 */
export function FormField({
	label,
	htmlFor,
	required,
	description,
	children,
	className,
}: FormFieldProps) {
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<Label htmlFor={htmlFor}>
				{label}
				{required && <span className="text-destructive">*</span>}
			</Label>
			{children}
			{description && (
				<p className="text-xs text-muted-foreground">{description}</p>
			)}
		</div>
	);
}

export interface FormSectionProps {
	/** セクションの見出し(fieldset の legend になる) */
	title: React.ReactNode;
	/** 見出しの直下に出す補足文。本文より先に読ませたい説明はこちら */
	description?: React.ReactNode;
	/** 見出し行の右端に置く操作(「記録を追加」ボタンなど) */
	action?: React.ReactNode;
	children: React.ReactNode;
	/** 本文ラッパのクラス(並びを変えたい場合など)。間隔の既定は上書きしない */
	className?: string;
}

/**
 * 見出し付きの入力グループ(fieldset + legend)。
 *
 * **legend は fieldset のフレックス整形文脈の外に描かれる**。fieldset の中身は
 * 匿名のコンテンツボックスに入り、`display:flex` や `gap` が効くのはその中だけで、
 * legend はその外側(上)に置かれる。つまり `<fieldset className="flex flex-col gap-3">`
 * と書いても legend と本文の間隔は 0 のままになる。
 *
 * これを知らずに `gap-3` を書き、足りない分を本文側の `-mt-2` で補っていたため、
 * 「産地紐付け(任意)」「飲んだ記録(任意)」では説明文が見出しに重なっていた
 * (gap が効かないので -8px がそのまま出る)。間隔は本文ラッパの margin-top
 * だけで作り、負のマージンは使わない。
 */
export function FormSection({
	title,
	description,
	action,
	children,
	className,
}: FormSectionProps) {
	return (
		<fieldset className="flex flex-col">
			{/*
			  legend は fieldset の直下の最初の子でなければグループ名として扱われない。
			  操作(action)を見出し行に並べたい場合も div で包まず legend の中に入れる。
			*/}
			<Label asChild>
				<legend className="w-full justify-between">
					<span>{title}</span>
					{action}
				</legend>
			</Label>
			<div className={cn(HEADING_GAP, "flex flex-col", CONTENT_GAP, className)}>
				{description && (
					<p className="text-xs text-muted-foreground">{description}</p>
				)}
				{children}
			</div>
		</fieldset>
	);
}
