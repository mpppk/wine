import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// シークレットの型宣言は env-secrets.d.ts に一本化する(#261)。
//
// `wrangler types` は素で実行するとローカルの .dev.vars も型に取り込むため、
// 手元でシークレットを設定している開発者が `bun run cf-typegen` を実行すると
// worker-configuration.d.ts にシークレットが**必須 string**で焼き込まれ、
// env-secrets.d.ts のオプショナル宣言と衝突する(skipLibCheck で黙殺される)。
// 生成結果が環境依存で揺れると、`if (!env.STRIPE_WEBHOOK_SECRET)` のような
// 未設定チェックが「型上は常に truthy」に見える環境と見えない環境が併存する。
//
// package.json の cf-typegen は `--env-file=/dev/null` でこれを防いでいるが、
// 素の `wrangler types` を実行して差分をコミットすれば元に戻ってしまうので、
// ここで結果を固定する。

const SECRET_KEYS = [
	"BETTER_AUTH_SECRET",
	"STRIPE_SECRET_KEY",
	"STRIPE_WEBHOOK_SECRET",
	"CAMPAIGN_EXTENSION_CODES",
] as const;

/** リポジトリルート起点で読む(vitest はルートで起動する) */
function read(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf8");
}

describe("シークレットの型宣言 (#261)", () => {
	it("worker-configuration.d.ts にシークレットが焼き込まれていない", () => {
		const generated = read("worker-configuration.d.ts");
		for (const key of SECRET_KEYS) {
			expect(
				generated.includes(key),
				`${key} が worker-configuration.d.ts に含まれています。素の \`wrangler types\` を実行していませんか(cf-typegen は --env-file=/dev/null 付きで実行する)`,
			).toBe(false);
		}
	});

	it("env-secrets.d.ts が全シークレットをオプショナルで宣言している", () => {
		const secrets = read("src/env-secrets.d.ts");
		for (const key of SECRET_KEYS) {
			expect(secrets).toContain(`${key}?: string;`);
		}
	});

	it("cf-typegen は .dev.vars を読ませない指定で実行される", () => {
		const pkg = JSON.parse(read("package.json")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts["cf-typegen"]).toContain("--env-file=/dev/null");
	});
});
