import { describe, expect, it } from "vitest";
import { m } from "#/paraglide/messages.js";
import { getLocale } from "#/paraglide/runtime.js";
import { paraglideMiddleware } from "#/paraglide/server.js";

async function runServerFunction(request: Request): Promise<Response> {
	return paraglideMiddleware(request, async () => {
		// This callback models a server function invoked from the Start handler.
		// It must observe the request locale through Paraglide's ALS context.
		await Promise.resolve();
		return Response.json({ locale: getLocale(), label: m.header_locale() });
	});
}

describe("Paraglide request context (#536)", () => {
	it("passes a cookie locale to SSR/server-function work in the same request", async () => {
		const [jaResponse, enResponse] = await Promise.all([
			runServerFunction(
				new Request("http://localhost:3000/profile", {
					headers: { Cookie: "wine_locale=ja" },
				}),
			),
			runServerFunction(
				new Request("http://localhost:3000/profile", {
					headers: { Cookie: "wine_locale=en" },
				}),
			),
		]);

		expect(await jaResponse.json()).toEqual({ locale: "ja", label: "言語" });
		expect(await enResponse.json()).toEqual({
			locale: "en",
			label: "Language",
		});
	});

	it("falls back to ja when the cookie is missing or unsupported", async () => {
		const response = await runServerFunction(
			new Request("http://localhost:3000/", {
				headers: { Cookie: "wine_locale=fr" },
			}),
		);

		expect(await response.json()).toEqual({ locale: "ja", label: "言語" });
	});
});
