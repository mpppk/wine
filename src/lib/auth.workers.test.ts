import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { auth } from "#/lib/auth";
import { signUpTestUser } from "#/lib/auth-test-helpers";

// better-auth のレートリミットを D1 永続ストレージ(rate_limit テーブル / drizzle/0017)で
// 有効化したこと(Issue #31)を実D1(miniflare)上で検証する。既定のインメモリ storage は
// Cloudflare Workers の isolate 分離下では全 isolate でカウンタを共有できず効かないため、
// storage:"database" に切り替えた。sign-in パスの既定スペシャルルール(10秒3回)が発火し、
// カウンタが D1 に永続化されることを確かめる。
//
// リクエストは GET を使う。sign-in の資格情報検証ロジックを走らせずにレートリミッタだけを
// 駆動でき(未マッチのメソッドは 404)、better-auth が資格情報エラー時に投げる
// unhandled rejection でテストランが汚れるのを避けられる。レートリミットはメソッドに依らず
// パスで発火するため、GET でも同じスペシャルルールが適用される。

const BASE_URL = "http://localhost:3000";

/** clientIp を渡すと CF-Connecting-IP 付きのリクエストになる(未指定なら従来どおりヘッダ無し) */
function signInProbe(clientIp?: string): Request {
	return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
		method: "GET",
		headers: clientIp
			? { origin: BASE_URL, "cf-connecting-ip": clientIp }
			: { origin: BASE_URL },
	});
}

/** rate_limit に載っているキーのうち sign-in のものを取り出す */
async function signInRateLimitKeys(): Promise<string[]> {
	const rows = await env.DB.prepare(
		"SELECT key FROM rate_limit WHERE key LIKE '%|/sign-in/email'",
	).all<{ key: string }>();
	return rows.results.map((r) => r.key);
}

/** 指定キーの現在のカウンタ値(未作成なら 0) */
async function rateLimitCount(key: string): Promise<number> {
	const row = await env.DB.prepare("SELECT count FROM rate_limit WHERE key = ?")
		.bind(key)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

describe("auth rate limiting (D1 permanent storage, #31)", () => {
	it("returns 429 once the sign-in special rule (10s/3) is exceeded", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			const res = await auth.handler(signInProbe());
			statuses.push(res.status);
		}
		// 4回目以降(既定スペシャルルール sign-in: 10秒3回を超過)は 429 になる。
		expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
		expect(statuses.at(-1)).toBe(429);
	});

	it("persists the rate-limit counter to the D1 rate_limit table", async () => {
		await auth.handler(signInProbe());
		// インメモリ storage ではこの行は作られない。D1 に載る = isolate 横断で効く。
		const row = await env.DB.prepare(
			"SELECT count(*) AS c FROM rate_limit",
		).first<{ c: number }>();
		expect(row?.c ?? 0).toBeGreaterThan(0);
	});
});

// クライアントIPが解決できないと、カウンタのキーが no-trusted-ip|<path> という
// 「パスごとの単一バケット」に潰れ、1クライアントが sign-in を10秒に3回叩くだけで
// その経路が全ユーザに対して閉じる(Issue #197)。better-auth の既定ヘッダは
// X-Forwarded-For だが Cloudflare 経由ではカンマ連結になりうるため信用されない。
// advanced.ipAddress.ipAddressHeaders に CF-Connecting-IP を指定して解決させる。
//
// テストごとに別のIPを使う。rate_limit は key に unique 制約があり行が残るため、
// 同じIPを使い回すと先行テストで消費済みのバケットを引いてしまう。
describe("auth rate limiting keys by client IP (#197)", () => {
	it("uses the CF-Connecting-IP address as the rate-limit key", async () => {
		// IPを解決できないリクエストが集約される共有バケット。この workers 環境は
		// NODE_ENV が test/development のいずれでもないため、better-auth のローカル
		// フォールバック(127.0.0.1)が効かず本番と同じ経路になる。上の #31 のテストが
		// IPヘッダ無しで叩いているので、この時点で既に行が存在する。
		const sharedKey = "no-trusted-ip|/sign-in/email";
		const sharedBefore = await rateLimitCount(sharedKey);

		await auth.handler(signInProbe("203.0.113.7"));

		// CF-Connecting-IP がキーになる。設定が無ければこのキーは作られない。
		expect(await signInRateLimitKeys()).toContain("203.0.113.7|/sign-in/email");
		// かつ、共有バケットは消費していない(IP単位に分かれている直接の証拠)。
		expect(await rateLimitCount(sharedKey)).toBe(sharedBefore);
	});

	it("does not let one client's requests exhaust another client's bucket", async () => {
		// IP-A で既定スペシャルルール(10秒3回)を超過すると 429 になる
		const noisy: number[] = [];
		for (let i = 0; i < 4; i++) {
			const res = await auth.handler(signInProbe("203.0.113.8"));
			noisy.push(res.status);
		}
		expect(noisy.at(-1)).toBe(429);

		// 別IPは巻き添えを食わない。共有バケットに潰れていると、ここが 429 になる。
		const other = await auth.handler(signInProbe("203.0.113.9"));
		expect(other.status).not.toBe(429);
	});
});

// MCP の OAuth 認可で同意と PKCE をサーバ側で強制する(Issue #633)。
//
// 背景: /api/auth/mcp/authorize は同意画面(/oauth/consent)の表示と PKCE が
// クライアントの申告(prompt=consent・code_challenge)に依存しており、動的クライアント
// 登録(RFC 7591)が無認証で開放されているため、悪用が可能だった。auth.ts で
// oidcConfig.requirePKCE=true と hooks.before での prompt=consent 強制を配線し、
// 第三者クライアントでも同意を迂回できず、PKCE 無しではコードもトークンも出ない。
//
// 注意: authorize のリダイレクト(ctx.redirect の FOUND)や token の 400 は、
// Response としては正しく返るが、better-auth が同じ APIError を unhandled rejection
// としても吐く(上記の #31 コメントと同型)。期待どおりの制御フロー分は
// vitest.config.ts の onUnhandledError で握り(MCP プラグイン由来に限定)、
// アサーション自体は status/location/body で判定するため検証は弱めない。

// RFC 7636 Appendix B の既知ペア(verifier→challenge の対応が正しいことが保証される)。
const MCP_PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const MCP_PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
// Inspector と同じコールバック先。DCR で登録した値と authorize/token で使う値を一致させる。
const MCP_TEST_REDIRECT_URI = "http://localhost:6274/oauth/callback";

/** 第三者クライアントを動的登録し、client_id を返す(Inspector の DCR と同じ経路) */
async function registerThirdPartyClient(clientIp: string): Promise<string> {
	const res = await auth.handler(
		new Request(`${BASE_URL}/api/auth/mcp/register`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: BASE_URL,
				"cf-connecting-ip": clientIp,
			},
			body: JSON.stringify({
				redirect_uris: [MCP_TEST_REDIRECT_URI],
				token_endpoint_auth_method: "none",
				client_name: "third-party probe",
			}),
		}),
	);
	expect(res.status).toBe(201);
	const body = (await res.json()) as { client_id: string };
	expect(body.client_id).toBeTruthy();
	return body.client_id;
}

/** ログイン済みユーザで authorize を叩く。prompt/PKCE の有無は args で切り替える */
function authorizeRequest(
	clientId: string,
	cookie: string,
	clientIp: string,
	args: {
		withPromptConsent?: boolean;
		withPkce?: boolean;
		// 平文 challenge の拒否テスト用。既定は RFC 7636 の S256 ペア。
		challenge?: string;
		challengeMethod?: string;
	} = {},
): Promise<Response> {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: MCP_TEST_REDIRECT_URI,
		response_type: "code",
		scope: "openid profile",
		state: "test-state",
	});
	if (args.withPromptConsent) params.set("prompt", "consent");
	// prompt 無しが既定。サーバ側の強制が無ければ、そのままコードが直接返る。
	if (args.withPkce !== false) {
		params.set("code_challenge", args.challenge ?? MCP_PKCE_CHALLENGE);
		params.set("code_challenge_method", args.challengeMethod ?? "S256");
	}
	return auth.handler(
		new Request(`${BASE_URL}/api/auth/mcp/authorize?${params}`, {
			method: "GET",
			headers: { cookie, origin: BASE_URL, "cf-connecting-ip": clientIp },
		}),
	);
}

/** 同意→認可コードまで進め、code を返す */
async function issueCodeViaConsent(
	clientId: string,
	cookie: string,
	clientIp: string,
): Promise<string> {
	const authRes = await authorizeRequest(clientId, cookie, clientIp);
	expect(authRes.status).toBe(302);
	const consentCode =
		new URL(authRes.headers.get("location") ?? "", BASE_URL).searchParams.get(
			"consent_code",
		) ?? "";
	expect(consentCode).not.toBe("");

	const consentRes = await auth.handler(
		new Request(`${BASE_URL}/api/auth/oauth2/consent`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: BASE_URL,
				cookie,
				"cf-connecting-ip": clientIp,
			},
			body: JSON.stringify({ accept: true, consent_code: consentCode }),
		}),
	);
	expect(consentRes.status).toBe(200);
	const { redirectURI } = (await consentRes.json()) as {
		redirectURI: string;
	};
	const code = new URL(redirectURI).searchParams.get("code") ?? "";
	expect(code).not.toBe("");
	return code;
}

/** 認可コードをトークンと交換する。code_verifier 無しも送れる */
function tokenRequest(args: {
	code: string;
	clientId: string;
	clientIp: string;
	withVerifier?: boolean;
}): Promise<Response> {
	return auth.handler(
		new Request(`${BASE_URL}/api/auth/mcp/token`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: BASE_URL,
				"cf-connecting-ip": args.clientIp,
			},
			body: JSON.stringify({
				grant_type: "authorization_code",
				code: args.code,
				redirect_uri: MCP_TEST_REDIRECT_URI,
				client_id: args.clientId,
				...(args.withVerifier ? { code_verifier: MCP_PKCE_VERIFIER } : {}),
			}),
		}),
	);
}

describe("MCP OAuth の同意と PKCE はサーバ側で強制される (#633)", () => {
	// rate_limit は key に unique 制約があり行が残るため、テストごとに別のIPを使う
	// (#197 と同じ理由。sign-up は既定スペシャルルール 10秒3回で、共有バケットだと
	// 4つ目の sign-up が 429 になる)。
	it("prompt無しの authorize は同意画面へ遷移し、コードを直接返さない", async () => {
		const ip = "203.0.113.101";
		const { cookie } = await signUpTestUser({
			name: "mcp consent",
			email: "mcp-consent-633@example.com",
			password: "test-password-256",
			clientIp: ip,
		});
		const clientId = await registerThirdPartyClient(ip);

		// クライアントは prompt を送らない(申告に依存していた旧経路の悪用形)。
		const res = await authorizeRequest(clientId, cookie, ip);
		expect(res.status).toBe(302);
		const location = res.headers.get("location") ?? "";
		// 同意画面へ行き、クライアントの redirect_uri へ直接コードは返さない。
		// 旧コードではここが redirect_uri?code=... になり、このテストが赤になる。
		expect(location.startsWith("/oauth/consent?")).toBe(true);
		expect(location).toContain("consent_code=");
		expect(location.startsWith(MCP_TEST_REDIRECT_URI)).toBe(false);
		expect(location).not.toContain("?code=");
		expect(location).not.toContain("&code=");
	});

	it("未ログインの authorize も強制後の query を保存し、再開時に同意が効く", async () => {
		const ip = "203.0.113.102";
		const clientId = await registerThirdPartyClient(ip);
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: MCP_TEST_REDIRECT_URI,
			response_type: "code",
			scope: "openid profile",
			state: "test-state",
			code_challenge: MCP_PKCE_CHALLENGE,
			code_challenge_method: "S256",
		});
		const res = await auth.handler(
			new Request(`${BASE_URL}/api/auth/mcp/authorize?${params}`, {
				method: "GET",
				headers: { "cf-connecting-ip": ip },
			}),
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")?.startsWith("/login")).toBe(true);
		// ログイン後の再開は oidc_login_prompt Cookie の query をそのまま使うため、
		// authorize 時点で強制した prompt=consent がここに残ることが効きの証拠。
		const loginPrompt = res.headers
			.getSetCookie()
			.find((c) => c.startsWith("oidc_login_prompt="));
		expect(loginPrompt).toBeTruthy();
		const encoded = loginPrompt?.split(";")[0]?.split("=")[1] ?? "";
		const dot = encoded.lastIndexOf(".");
		const stored = JSON.parse(
			decodeURIComponent(dot > 0 ? encoded.slice(0, dot) : encoded),
		) as { prompt?: string };
		expect(stored.prompt).toBe("consent");
	});

	it("PKCE無しの authorize は invalid_request で拒否される", async () => {
		const ip = "203.0.113.103";
		const { cookie } = await signUpTestUser({
			name: "mcp pkce",
			email: "mcp-pkce-633@example.com",
			password: "test-password-256",
			clientIp: ip,
		});
		const clientId = await registerThirdPartyClient(ip);

		const res = await authorizeRequest(clientId, cookie, ip, {
			withPkce: false,
		});
		expect(res.status).toBe(302);
		const location = res.headers.get("location") ?? "";
		// 旧コードでは PKCE 無しでも同意画面か直接コードが返り、このテストが赤になる。
		expect(location.startsWith(MCP_TEST_REDIRECT_URI)).toBe(true);
		expect(location).toContain("error=invalid_request");
		expect(location).toContain("pkce");
	});

	it("PKCE無しのコード交換は拒否される", async () => {
		const ip = "203.0.113.104";
		const { cookie } = await signUpTestUser({
			name: "mcp token",
			email: "mcp-token-633@example.com",
			password: "test-password-256",
			clientIp: ip,
		});
		const clientId = await registerThirdPartyClient(ip);
		const code = await issueCodeViaConsent(clientId, cookie, ip);

		const res = await tokenRequest({ code, clientId, clientIp: ip });
		expect(res.status).toBe(400);
		// body も消費して内容まで確かめる(verifier 無しが理由であること)。
		const body = (await res.json()) as {
			error?: string;
			error_description?: string;
		};
		expect(body.error).toBe("invalid_request");
		expect(body.error_description ?? "").toContain("code verifier");
	});

	it("平文 challenge(S256以外)は拒否される(allowPlain=false の回帰防止)", async () => {
		const ip = "203.0.113.106";
		const { cookie } = await signUpTestUser({
			name: "mcp plain",
			email: "mcp-plain-633@example.com",
			password: "test-password-256",
			clientIp: ip,
		});
		const clientId = await registerThirdPartyClient(ip);

		// plain では challenge が verifier そのもの。S256 換算値は送らない。
		const res = await authorizeRequest(clientId, cookie, ip, {
			challenge: MCP_PKCE_VERIFIER,
			challengeMethod: "plain",
		});
		expect(res.status).toBe(302);
		const location = res.headers.get("location") ?? "";
		// 既定でも plain は不許可だが、auth.ts で明示した設定の回帰防止として固定する。
		expect(location.startsWith(MCP_TEST_REDIRECT_URI)).toBe(true);
		expect(location).toContain("error=invalid_request");
		expect(location).toContain("invalid code_challenge method");
	});

	it("PKCEありの正規のコード交換は通る(既存クライアントの回帰防止)", async () => {
		const ip = "203.0.113.105";
		const { cookie } = await signUpTestUser({
			name: "mcp legit",
			email: "mcp-legit-633@example.com",
			password: "test-password-256",
			clientIp: ip,
		});
		const clientId = await registerThirdPartyClient(ip);
		const code = await issueCodeViaConsent(clientId, cookie, ip);

		const res = await tokenRequest({
			code,
			clientId,
			clientIp: ip,
			withVerifier: true,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			access_token?: string;
			token_type?: string;
		};
		expect(body.access_token).toBeTruthy();
		expect(body.token_type?.toLowerCase()).toBe("bearer");
	});
});
