import { SELF } from "cloudflare:test";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { describe, expect, it } from "vitest";

// `getLocaleProbe` is a real GET server function in the application graph. The
// integration project runs Vite's dev-mode Start compiler, whose ID is a
// deterministic base64url encoding of the relative provider module and the
// generated handler export name.
const LOCALE_PROBE_SERVER_FN_ID =
	"eyJmaWxlIjoiL3NyYy9zZXJ2ZXIvYWZmaWxpYXRlLnRzP3Rzcy1zZXJ2ZXJmbi1zcGxpdCIsImV4cG9ydCI6ImdldExvY2FsZVByb2JlX2NyZWF0ZVNlcnZlckZuX2hhbmRsZXIifQ";

const processLike = (
	globalThis as typeof globalThis & {
		process: { env: Record<string, string | undefined> };
	}
).process;
processLike.env.TSS_SERVER_FN_BASE = "/_serverFn/";

const localeProbeRpc = createClientRpc(LOCALE_PROBE_SERVER_FN_ID);

async function callLocaleProbe(cookie: string): Promise<{
	status: number;
	serialized: string | null;
	result: { locale: string; label: string };
}> {
	let status = 0;
	let serialized: string | null = null;
	const envelope = await runWithStartContext(
		{
			getRouter: async () => {
				throw new Error("router is not used by this transport test");
			},
			request: new Request("http://localhost/_serverFn/"),
			startOptions: {},
			contextAfterGlobalMiddlewares: {},
			executedRequestMiddlewares: new Set(),
			handlerType: "serverFn",
		},
		() =>
			localeProbeRpc({
				method: "GET",
				headers: {
					Cookie: cookie,
					// Match the same-origin browser request accepted by Start's CSRF
					// middleware (SELF.fetch does not synthesize Origin for us).
					Origin: "http://localhost",
				},
				// Use Start's actual client transport/decoder, but route its fetch through
				// the application Worker's real service binding in workerd.
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					const response = await SELF.fetch(
						new Request(new URL(String(input), "http://localhost"), init),
					);
					status = response.status;
					serialized = response.headers.get("x-tss-serialized");
					return response;
				},
			}),
	);

	return {
		status,
		serialized,
		result: envelope.result as { locale: string; label: string },
	};
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
		// The Sentry wrapper around the application Worker keeps request-scoped I/O
		// objects, which workerd does not allow to be used across concurrent
		// requests. Keep the two locale assertions deterministic and sequential.
		const jaResponse = await callLocaleProbe("wine_locale=ja");
		const enResponse = await callLocaleProbe("wine_locale=en");

		// The request went through the actual Start `/_serverFn/<id>` dispatcher,
		// and Start's own client transport decoder unwrapped the result envelope.
		expect(jaResponse.status).toBe(200);
		expect(enResponse.status).toBe(200);
		expect(jaResponse.serialized).toBe("true");
		expect(enResponse.serialized).toBe("true");
		expect(jaResponse.result).toEqual({ locale: "ja", label: "言語" });
		expect(enResponse.result).toEqual({
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
		expect(html).toContain("<title>Wine AOP Learning App</title>");
	});

	it("uses ja for a missing or unsupported cookie on the real application handler", async () => {
		const missingResponse = await renderHome("");
		const unsupportedResponse = await renderHome("wine_locale=fr");
		expect(missingResponse.status).toBe(200);
		expect(unsupportedResponse.status).toBe(200);

		const missing = await missingResponse.text();
		const unsupported = await unsupportedResponse.text();
		expect(missing).toContain('<html lang="ja"');
		expect(missing).toContain("<title>ワインAOP学習アプリ</title>");
		expect(unsupported).toContain('<html lang="ja"');
		expect(unsupported).toContain("<title>ワインAOP学習アプリ</title>");
	});
});
