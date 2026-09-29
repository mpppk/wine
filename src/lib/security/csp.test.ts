import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";

// ディレクティブ名→値に分解する。重複ディレクティブはテストを落とす
// (ブラウザは最初の1つだけを適用し、残りを黙って捨てるため)。
function parseCsp(policy: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const part of policy.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const space = trimmed.indexOf(" ");
		expect(space).toBeGreaterThan(0);
		const name = trimmed.slice(0, space);
		expect(map.has(name)).toBe(false);
		map.set(name, trimmed.slice(space + 1).trim());
	}
	return map;
}

describe("buildCsp", () => {
	it("通常ページは frame-ancestors 'none' を含む", () => {
		const directives = parseCsp(buildCsp());
		expect(directives.get("frame-ancestors")).toBe("'none'");
	});

	it("通常ページは base-uri / object-src / form-action を含む", () => {
		const directives = parseCsp(buildCsp());
		expect(directives.get("base-uri")).toBe("'self'");
		expect(directives.get("object-src")).toBe("'none'");
		expect(directives.get("form-action")).toBe("'self'");
	});

	it("埋め込みページは frame-ancestors を省き、他は維持する", () => {
		const directives = parseCsp(buildCsp({ allowEmbedding: true }));
		expect(directives.has("frame-ancestors")).toBe(false);
		expect(directives.get("base-uri")).toBe("'self'");
		expect(directives.get("object-src")).toBe("'none'");
		expect(directives.get("form-action")).toBe("'self'");
	});

	it("空ポリシーを返さない(旧来の打ち消しへの回帰防止)", () => {
		expect(buildCsp().trim().length).toBeGreaterThan(0);
		expect(buildCsp({ allowEmbedding: true }).trim().length).toBeGreaterThan(0);
	});

	it("ヘッダ値を固定する(意図せぬ変更の検出)", () => {
		expect(buildCsp()).toBe(
			"frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
		);
		expect(buildCsp({ allowEmbedding: true })).toBe(
			"base-uri 'self'; form-action 'self'; object-src 'none'",
		);
	});
});

// 経路ごとの手書き文字列への回帰を防ぐ。`headers()` の実値は SSR 経由でしか
// 取れない(ルートモジュールは server fn 経由で cloudflare:workers を引くため
// unit では import できない)ので、配線自体をソース検査で見張る。
describe("CSP 配線(ソース検査)", () => {
	const root = readFileSync(
		join(process.cwd(), "src/routes/__root.tsx"),
		"utf8",
	);
	const embedMap = readFileSync(
		join(process.cwd(), "src/routes/embed/map.tsx"),
		"utf8",
	);
	const embedDrunkWine = readFileSync(
		join(process.cwd(), "src/routes/embed/drunk-wine.tsx"),
		"utf8",
	);

	it("__root は buildCsp() から導出する", () => {
		expect(root).toContain("buildCsp()");
		expect(root).not.toContain("\"frame-ancestors 'none'\"");
	});

	it("埋め込み2ルートは allowEmbedding から導出し、空文字で打ち消さない", () => {
		for (const source of [embedMap, embedDrunkWine]) {
			expect(source).toContain("buildCsp({ allowEmbedding: true })");
			expect(source).not.toContain('"Content-Security-Policy": ""');
		}
	});

	it("frame-ancestors * を使わない(不透明オリジンで拒否される #189)", () => {
		// コメント中の言及(バッククォート囲み)は除外し、ヘッダ値としての
		// 出現(`*` の直後に `'`, `"`, `;` が来る形)だけを見る。
		for (const source of [root, embedMap, embedDrunkWine]) {
			expect(source).not.toMatch(/frame-ancestors \*['";]/);
		}
	});
});
