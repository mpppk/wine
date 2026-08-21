import { describe, expect, it } from "vitest";
import { langfuseMask } from "./langfuse-mask";

describe("langfuseMask", () => {
	it("文字列以外は素通しする", () => {
		expect(langfuseMask({ data: 42 })).toBe(42);
		expect(langfuseMask({ data: null })).toBe(null);
		expect(langfuseMask({ data: undefined })).toBe(undefined);
		const obj = { foo: "bar" };
		expect(langfuseMask({ data: obj })).toBe(obj);
	});

	it("data: URI を落とす", () => {
		const input = "prefix data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ suffix";
		const out = langfuseMask({ data: input }) as string;
		expect(out).not.toContain("data:");
		expect(out).toContain("[data URI omitted]");
	});

	it("data: URI（非base64）も落とす", () => {
		const input = "hello data:text/plain,HelloWorld there";
		const out = langfuseMask({ data: input }) as string;
		expect(out).not.toContain("data:text");
		expect(out).toContain("[data URI omitted]");
	});

	it("長大な base64 らしき文字列を落とす", () => {
		const b64 = "A".repeat(300);
		const input = `before ${b64} after`;
		const out = langfuseMask({ data: input }) as string;
		expect(out).not.toContain(b64);
		expect(out).toContain("[base64 omitted]");
	});

	it("短い base64 は落とさない", () => {
		const short = "abc123+/=";
		expect(langfuseMask({ data: short })).toBe(short);
	});

	it("sk- 形式のシークレットを落とす", () => {
		const input = "key is sk-abc123DEF456ghi789jkl0 suffix";
		const out = langfuseMask({ data: input }) as string;
		expect(out).not.toContain("sk-abc123");
		expect(out).toContain("[secret omitted]");
	});

	it("pk-lf- 形式を落とす", () => {
		const input = "key pk-lf-abc123DEF456ghi789jkl0 end";
		const out = langfuseMask({ data: input }) as string;
		expect(out).not.toContain("pk-lf-");
		expect(out).toContain("[secret omitted]");
	});

	it("Bearer トークンを落とす", () => {
		const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
		const out = langfuseMask({ data: input }) as string;
		expect(out).not.toContain("eyJhbGci");
		expect(out).toContain("Bearer [secret omitted]");
	});

	it("長すぎるテキストを切り詰める（切り詰めたことが分かる形で）", () => {
		const long = "hello world. ".repeat(700);
		const out = langfuseMask({ data: long }) as string;
		expect(out.length).toBeLessThan(long.length);
		expect(out).toContain("[truncated:");
		expect(out).toContain("chars omitted]");
	});

	it("通常のテキストはそのまま通す", () => {
		const input = "Bordeaux is a wine region in France.";
		expect(langfuseMask({ data: input })).toBe(input);
	});

	it("JSON 文字列の中の data URI も落とす", () => {
		const json = JSON.stringify({ image: "data:image/jpeg;base64,/9j/4AAQ" });
		const out = langfuseMask({ data: json }) as string;
		expect(out).not.toContain("data:");
		expect(out).toContain("[data URI omitted]");
	});
});
