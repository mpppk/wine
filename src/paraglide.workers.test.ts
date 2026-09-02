import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// `getLocaleProbe` is a real GET server function in the application graph. Its
// generated ID is deterministic (relative source path + exported function name) and
// is the URL used by the client RPC stub in the built Worker.
const LOCALE_PROBE_SERVER_FN_URL =
	"http://localhost/_serverFn/70b21c14ef4f75a586f301f122ef2fc219e78d252689026164d665ffbc06575d";

async function callLocaleProbe(cookie: string): Promise<Response> {
	return SELF.fetch(
		new Request(LOCALE_PROBE_SERVER_FN_URL, {
			method: "GET",
			headers: {
				Cookie: cookie,
				// This is the header emitted by TanStack Start's serverFnFetcher.
				"x-tsr-serverFn": "true",
				Accept: "application/json",
			},
		}),
	);
}

async function renderHome(cookie: string): Promise<Response> {
	return SELF.fetch(
		new Request("http://localhost/", {
			headers: {
				Cookie: cookie,
				Accept: "text/html",
			},
		}),
	);
}

describe("Paraglide request context through the application Worker (#536)", () => {
	it("runs a real Start server-function RPC and resolves its request locale", async () => {
		const [jaResponse, enResponse] = await Promise.all([
			callLocaleProbe("wine_locale=ja"),
			callLocaleProbe("wine_locale=en"),
		]);

		// The request went through the actual Start `/_serverFn/<id>` dispatcher,
		// rather than a callback that merely resembles a server function.
		expect(jaResponse.status).toBe(200);
		expect(enResponse.status).toBe(200);
		expect(jaResponse.headers.get("x-tss-serialized")).toBe("true");
		expect(enResponse.headers.get("x-tss-serialized")).toBe("true");
		expect(await jaResponse.json()).toEqual({ locale: "ja", label: "言語" });
		expect(await enResponse.json()).toEqual({
			locale: "en",
			label: "Language",
		});

		// The same application Worker fetch is wrapped by paraglideMiddleware in
		// src/worker.ts, so the Start SSR handler also resolves getLocale() and m.*
		// calls from the cookie while rendering the real root route.
		const htmlResponse = await renderHome("wine_locale=en");
		expect(htmlResponse.status).toBe(200);
		expect(htmlResponse.headers.get("vary")).toBe("Cookie");
		const html = await htmlResponse.text();
		expect(html).toContain('<html lang="en"');
		expect(html).toContain("Language");
	});

	it("uses ja for a missing or unsupported cookie on the real application handler", async () => {
		const [missingResponse, unsupportedResponse] = await Promise.all([
			renderHome(""),
			renderHome("wine_locale=fr"),
		]);
		expect(missingResponse.status).toBe(200);
		expect(unsupportedResponse.status).toBe(200);

		const [missing, unsupported] = await Promise.all([
			missingResponse.text(),
			unsupportedResponse.text(),
		]);
		expect(missing).toContain('<html lang="ja"');
		expect(missing).toContain("言語");
		expect(unsupported).toContain('<html lang="ja"');
		expect(unsupported).toContain("言語");
	});
});
