import { describe, expect, it } from "vitest";
import { cn } from "#/lib/utils";

describe("cn", () => {
	it("merges class names", () => {
		expect(cn("px-2", "py-1")).toBe("px-2 py-1");
	});

	it("resolves conflicting tailwind classes with the last one winning", () => {
		expect(cn("px-2", "px-4")).toBe("px-4");
	});

	it("ignores falsy values", () => {
		expect(cn("px-2", false, null, undefined, "py-1")).toBe("px-2 py-1");
	});
});
