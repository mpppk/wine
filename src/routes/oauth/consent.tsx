import { createFileRoute } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { authClient } from "#/lib/auth-client";
import {
	describeOAuthScope,
	MCP_TOKEN_CAPABILITIES,
} from "#/lib/oauth/scope-description";
import { getOAuthClientSummary } from "#/server/oauth";

type ConsentSearch = {
	consent_code?: string;
	client_id?: string;
	scope?: string;
};

// OAuth consent page. better-auth's mcp plugin redirects here (with a signed
// oidc_consent_prompt cookie) when an authorize request carries
// prompt=consent; POSTing the decision returns the client redirect URI.
//
// **同意フィッシング対策がこの画面の主目的**(#399)。動的クライアント登録(RFC 7591)を
// 無認証で開放しているため、攻撃者は自前の redirect_uri でクライアントを登録し、
// 被害者(あるいは MCP を扱う LLM エージェント)にこの画面のリンクを踏ませるだけでよい。
// 承認されると MCP ツール全面 — 氏名/メールの読み出し・記録の読み書き・AIクレジットの
// 消費 — のトークンが渡る。
//
// したがってこの画面は「利用者が"何が・どこへ"渡るのかを判断できる」ことに責任を持つ:
//  - クライアント名と**認可コードの送り先ホスト**を出す
//  - ただし**それらは攻撃者が自由に登録できる申告値**なので、検証済みに見せない
//  - 「実際に何ができるようになるか」を先に出す。要求スコープの羅列では判断材料にならず、
//    しかもこのアプリはスコープでツールを絞っていないため実態より狭く見える
export const Route = createFileRoute("/oauth/consent")({
	validateSearch: (search: Record<string, unknown>): ConsentSearch => ({
		consent_code:
			typeof search.consent_code === "string" ? search.consent_code : undefined,
		client_id:
			typeof search.client_id === "string" ? search.client_id : undefined,
		scope: typeof search.scope === "string" ? search.scope : undefined,
	}),
	loaderDeps: ({ search }) => ({ clientId: search.client_id }),
	loader: async ({ deps }) => {
		if (!deps.clientId) return null;
		// 取得に失敗しても同意画面自体は出す(詳細が出せないぶん警告を強める)。
		// ここで throw すると、正規のクライアントからの認可まで巻き添えで止まる。
		return getOAuthClientSummary({ data: { clientId: deps.clientId } }).catch(
			() => null,
		);
	},
	component: ConsentPage,
});

function ConsentPage() {
	const { consent_code, client_id, scope } = Route.useSearch();
	const client = Route.useLoaderData();
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState<"accept" | "deny" | null>(null);

	const scopes = (scope ?? "").split(" ").filter(Boolean);

	const decide = async (accept: boolean) => {
		setError("");
		setSubmitting(accept ? "accept" : "deny");
		try {
			const { data, error: err } = await authClient.$fetch<{
				redirectURI?: string;
			}>("/oauth2/consent", {
				method: "POST",
				body: { accept, consent_code },
			});
			const redirectURI = (data as { redirectURI?: string } | null)
				?.redirectURI;
			if (err) {
				setError(err.message || "同意の送信に失敗しました");
			} else if (redirectURI) {
				window.location.assign(redirectURI);
				return;
			} else if (accept) {
				setError("リダイレクト先が返されませんでした");
			} else {
				window.close();
			}
		} catch (_e) {
			setError("予期しないエラーが発生しました");
		} finally {
			setSubmitting(null);
		}
	};

	if (!consent_code) {
		return (
			<div className="flex justify-center px-4 py-10">
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>不正な認可リクエストです</CardTitle>
						<CardDescription>
							このページはアプリケーションからの認可リクエスト経由で開く必要があります。
						</CardDescription>
					</CardHeader>
				</Card>
			</div>
		);
	}

	return (
		<div className="flex justify-center px-4 py-10">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>アプリケーションへのアクセスを許可しますか？</CardTitle>
					<CardDescription>
						許可すると、このアプリケーションはあなたのアカウントとして操作できるようになります。
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					<dl className="space-y-3 rounded-md border p-3 text-sm">
						<div>
							<dt className="text-muted-foreground">アプリ名（申告値）</dt>
							{/* 攻撃者が任意に登録できる値。等幅で出して、周囲の文言と
							    見分けが付くようにする */}
							<dd className="break-all font-mono">
								{client?.name ?? "（名前の登録なし）"}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">
								認可コードの送り先（申告値）
							</dt>
							<dd className="break-all font-mono">
								{client && client.redirectHosts.length > 0
									? client.redirectHosts.join(", ")
									: "（不明）"}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">client_id</dt>
							<dd className="break-all font-mono text-muted-foreground text-xs">
								{client_id ?? "（不明）"}
							</dd>
						</div>
					</dl>

					{/* 「アプリ名と送り先は誰でも自由に名乗れる」ことを明示するのが本題。
					    ここが無いと、名前を偽装したクライアントを利用者が信用してしまう */}
					<div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
						<TriangleAlertIcon
							className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500"
							aria-hidden
						/>
						<div className="space-y-1 text-sm">
							<p className="font-medium">このアプリは審査されていません</p>
							<p className="text-muted-foreground">
								アプリ名も送り先も、登録した人が自由に決められる値です。
								<strong className="font-medium text-foreground">
									自分で始めた操作でない場合や、送り先に心当たりが無い場合は許可しないでください。
								</strong>
							</p>
						</div>
					</div>

					{/* **要求スコープではなく「実際にできること」を先に出す**。このアプリの MCP は
					    スコープでツールを絞っていないので、スコープ一覧だけでは実際より狭い
					    権限だと誤解させる(scope-description.ts のコメント参照) */}
					<div>
						<p className="mb-2 font-medium text-sm">許可すると、このアプリは</p>
						<ul className="space-y-1 text-muted-foreground text-sm">
							{MCP_TOKEN_CAPABILITIES.map((capability) => (
								<li key={capability} className="flex gap-2">
									<span aria-hidden>・</span>
									<span>{capability}</span>
								</li>
							))}
						</ul>
					</div>

					{scopes.length > 0 && (
						<details className="text-sm">
							<summary className="cursor-pointer text-muted-foreground">
								要求されたスコープ（{scopes.length}件）
							</summary>
							<ul className="mt-2 space-y-1 text-muted-foreground">
								{scopes.map((s) => (
									<li key={s} className="flex gap-2">
										<span aria-hidden>・</span>
										<span>
											{describeOAuthScope(s)}
											<span className="ml-1 font-mono text-xs opacity-60">
												({s})
											</span>
										</span>
									</li>
								))}
							</ul>
						</details>
					)}

					{error && (
						<div className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
							<p className="text-destructive text-sm">{error}</p>
						</div>
					)}

					{/* 既定の視線誘導を「許可しない」側に置く。許可は取り返しが付かない操作なので、
					    強調表示(primary)は許可ではなく拒否に当てる */}
					<div className="flex gap-3">
						<Button
							type="button"
							variant="outline"
							className="flex-1"
							disabled={submitting !== null}
							onClick={() => void decide(true)}
						>
							{submitting === "accept" ? "送信中…" : "許可する"}
						</Button>
						<Button
							type="button"
							className="flex-1"
							disabled={submitting !== null}
							onClick={() => void decide(false)}
						>
							{submitting === "deny" ? "送信中…" : "許可しない"}
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
