import { describe, expect, it } from "vitest";
import {
	checkTemplateVariables,
	compileFallbackTemplate,
	extractTemplateVariables,
	hasUnresolvedPlaceholders,
	MANAGED_PROMPTS,
	REGION_QA_SYSTEM_PROMPT,
} from "./managed-prompts";

describe("MANAGED_PROMPTS", () => {
	it("名前が重複しない(ラベルで版を選ぶので名前が識別子)", () => {
		const names = MANAGED_PROMPTS.map((p) => p.name);
		expect(new Set(names).size).toBe(names.length);
	});

	// `compile()` は Record<string, string> を取るので型が効かない。宣言した変数と
	// テンプレート中の {{…}} が食い違うと、実行時ガードが自分の定義を弾き続ける
	// (= Langfuse の版が永久に効かない)ので、ここで固定する。
	it.each(MANAGED_PROMPTS.map((p) => [p.name, p] as const))(
		"%s: 宣言した変数とテンプレート中の {{…}} が一致する",
		(_name, definition) => {
			expect([...extractTemplateVariables(definition.template)].sort()).toEqual(
				[...definition.variables].sort(),
			);
		},
	);
});

describe("REGION_QA_SYSTEM_PROMPT", () => {
	it("ガードレールを持ち、地域情報は変数で受ける", () => {
		const t = REGION_QA_SYSTEM_PROMPT.template;
		expect(t).toContain("ワインに関する学習を助ける日本語アシスタント");
		expect(t).toContain("事実を創作しない");
		expect(t).toContain("# 地域情報");
		expect(t).toContain("{{region_context}}");
		// マスタ由来の一覧を焼き込まない(焼き込むと Langfuse への再登録が要る)。
		expect(t.length).toBeLessThan(500);
	});
});

describe("extractTemplateVariables", () => {
	it("重複を畳んで列挙する", () => {
		expect(extractTemplateVariables("{{a}} {{b}} {{a}}").sort()).toEqual([
			"a",
			"b",
		]);
	});

	it("前後の空白を許す", () => {
		expect(extractTemplateVariables("{{  a  }}")).toEqual(["a"]);
	});

	it("セクション・コメントは変数として数えない", () => {
		expect(extractTemplateVariables("{{#s}}x{{/s}}{{!c}}")).toEqual([]);
	});
});

describe("checkTemplateVariables", () => {
	const supplied = { region_context: "ブルゴーニュ" };

	it("必須変数が揃っていれば両方空", () => {
		expect(
			checkTemplateVariables("A{{region_context}}B", {
				required: ["region_context"],
				supplied,
			}),
		).toEqual({ missing: [], unknown: [] });
	});

	it("必須変数が消されていたら missing に出る", () => {
		expect(
			checkTemplateVariables("グラウンディング無しの指示文", {
				required: ["region_context"],
				supplied,
			}),
		).toEqual({ missing: ["region_context"], unknown: [] });
	});

	it("コードが渡さない変数が足されていたら unknown に出る", () => {
		expect(
			checkTemplateVariables("{{region_context}} {{tone}}", {
				required: ["region_context"],
				supplied,
			}),
		).toEqual({ missing: [], unknown: ["tone"] });
	});
});

describe("hasUnresolvedPlaceholders", () => {
	it("残っていれば true", () => {
		expect(hasUnresolvedPlaceholders("答え: {{foo}}")).toBe(true);
	});

	it("残っていなければ false", () => {
		expect(hasUnresolvedPlaceholders("答え: ブルゴーニュ")).toBe(false);
	});
});

describe("compileFallbackTemplate", () => {
	it("変数を差し込む(同じ変数が複数回出てもすべて)", () => {
		expect(
			compileFallbackTemplate("{{a}}/{{a}}/{{b}}", { a: "1", b: "2" }),
		).toBe("1/1/2");
	});

	it("値の中の {{…}} を再展開しない(注入を1段に留める)", () => {
		expect(compileFallbackTemplate("{{a}}", { a: "{{b}}" })).toBe("{{b}}");
	});

	it("渡されなかった変数はそのまま残す(hasUnresolvedPlaceholders が拾える形)", () => {
		expect(compileFallbackTemplate("{{a}}{{z}}", { a: "1" })).toBe("1{{z}}");
	});
});
