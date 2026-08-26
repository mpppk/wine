// Langfuse のプロンプト管理下にあるプロンプトの登録簿(#512 Phase 4)。
//
// **本文のSSOTは Langfuse 側にある。** ここに置く `template` は2つの役割しか持たない:
//  1. Langfuse が使えないとき(キー未設定・取得失敗・壊れた版)の fallback
//  2. `bun run sync:prompts` で Langfuse へ初期登録するときの種
//
// この転換は #512 本文の「Langfuse Prompts は使わない」を意図的に覆したもの。
// デプロイと無関係にモデルの挙動が変わることを許容し、代わりに評価のループ
// (編集 → preview で試す → production へ昇格 → ラベルを戻して巻き戻し)を優先する。
// 失われる「型とテストによる保証」は `langfuse-prompt.ts` の実行時ガードで補う。
//
// **このファイルは env にもマスタデータにも依存させない。** workerd 上の
// `langfuse-prompt.ts` と Bun 上の `scripts/sync-langfuse-prompts.ts` の両方が読み、
// unit テスト(jsdom)からも読む。マスタ由来の一覧(呼称・品種など)を将来ここへ
// 足すときは、テンプレートへ焼き込まずに**変数として実行時に注入する**こと
// (焼き込むと `aops.json` を更新するたびに Langfuse への再登録が要る上、
// クライアントバンドルへマスタが載る)。

/** Langfuse で管理する1本のプロンプト。 */
export interface ManagedPromptDefinition {
	/** Langfuse 上のプロンプト名。ラベル(`production` / `preview`)で版を選ぶ。 */
	name: string;
	/** fallback 兼 初期登録の種。`{{変数名}}` で変数を埋め込む。 */
	template: string;
	/**
	 * このプロンプトが必ず要求する変数。
	 *
	 * `compile()` は `Record<string, string>` を取るので型で守れない。実行時ガード
	 * (`langfuse-prompt.ts`)が「取得した版にこれが全て現れるか」を検査し、欠けていれば
	 * fallback へ落とす —— Langfuse 側で `{{region_context}}` を消されたときに
	 * グラウンディングが黙って消滅するのを防ぐ。
	 */
	variables: readonly string[];
}

/**
 * テンプレート中の `{{変数名}}` を列挙する(重複は畳む)。
 *
 * 数えるのは `{{名前}}` の形だけ。mustache のセクション(`{{#x}}` / `{{/x}}` / `{{^x}}`)や
 * コメント(`{{!x}}`)は**変数として数えない**(名前に使える文字を英数字と `_` に限っているため)。
 * この登録簿に置く `template` 自身は単純な差し込みだけで書く —— fallback の差し込みは
 * `compileFallbackTemplate` の素朴な置換で行うため、制御構文を書くと展開されない。
 * Langfuse 側の版は SDK の mustache で展開されるので制御構文も動く。
 */
export function extractTemplateVariables(template: string): string[] {
	const found = new Set<string>();
	for (const m of template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
		const name = m[1];
		if (name) found.add(name);
	}
	return [...found];
}

/**
 * 地域Q&A の system プロンプト。ガードレールだけを持ち、閲覧中のページの地域情報は
 * `region_context` として実行時に注入する(`buildRegionContext` が組み立てる)。
 */
export const REGION_QA_SYSTEM_PROMPT: ManagedPromptDefinition = {
	name: "region-qa-system",
	template: [
		"あなたはワインに関する学習を助ける日本語アシスタントです。",
		"ユーザからの質問に対して簡潔(3〜5文程度)な日本語で答えてください。",
		"- ワインの学習に無関係な質問には丁寧に断る。",
		"- 事実を創作しない。",
		"",
		"なお、以下はユーザが現在閲覧しているページの情報です。これを踏まえた回答を行なってください",
		"# 地域情報",
		"{{region_context}}",
	].join("\n"),
	variables: ["region_context"],
};

/**
 * Langfuse 管理下のプロンプト全件。実行時・同期スクリプト・テストが同じ定義を読む。
 * **ここに載っていないプロンプトは Langfuse を見ない**(コードがそのまま正)。
 */
export const MANAGED_PROMPTS: readonly ManagedPromptDefinition[] = [
	REGION_QA_SYSTEM_PROMPT,
];

/** `checkTemplateVariables` の結果。両方空なら、その版はコードが差し込める。 */
export interface TemplateVariableMismatch {
	/** 必須なのにテンプレートから消えている変数。 */
	missing: string[];
	/** テンプレートが要求しているのにコードが渡していない変数。 */
	unknown: string[];
}

/**
 * 取得した版をコードが差し込めるかを検査する。**型とテストを失ったぶんをここで
 * 取り戻す**のが役目で、どちらかが空でなければ呼び出し側は fallback へ落とす。
 *
 * 2方向を見るのは、mustache がどちらの食い違いも**黙って**畳んでしまうため:
 *
 *  - `missing`: `{{region_context}}` を消されると、グラウンディング無しのまま推論が走る
 *  - `unknown`: 新しい `{{tone}}` を足されると、コードが値を持たないので空文字に畳まれ、
 *    書いた本人の意図した文面にならないまま本番へ出る
 *
 * `unknown` を弾く結果として、**変数を増やす版はコード側が追随するまで効かない**。
 * それが狙いで、効かなかったことは warn ログと `promptSource` から分かる。
 */
export function checkTemplateVariables(
	template: string,
	args: { required: readonly string[]; supplied: Record<string, string> },
): TemplateVariableMismatch {
	const declared = extractTemplateVariables(template);
	const declaredSet = new Set(declared);
	return {
		missing: args.required.filter((name) => !declaredSet.has(name)),
		unknown: declared.filter((name) => !(name in args.supplied)),
	};
}

/**
 * 差し込み後に未解決の `{{…}}` が残っていないか(最後の保険)。
 *
 * 変数の食い違いは `checkTemplateVariables` が先に弾くので、ここに掛かるのは
 * mustache が展開しきれなかった壊れた記法だけ。掛かったらその版は使わない。
 */
export function hasUnresolvedPlaceholders(text: string): boolean {
	return /\{\{[^}]*\}\}/.test(text);
}

/**
 * コードの fallback テンプレートを差し込む。
 *
 * **対象は `MANAGED_PROMPTS` の `template` だけ**で、単純な `{{変数名}}` しか含まない
 * (登録簿の規約)。Langfuse から取れた版は SDK の `compile()`(mustache)で差し込み、
 * Playground / Experiments と同じ意味論に揃える —— 実行時だけ別の展開規則にすると
 * 「Playground では通ったのに本番で違う」が起きる。
 */
export function compileFallbackTemplate(
	template: string,
	variables: Record<string, string>,
): string {
	return template.replace(
		/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
		(match, name: string) => variables[name] ?? match,
	);
}
