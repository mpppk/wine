import { createElement, type ReactNode } from "react";
import { vi } from "vitest";

// jsdom 単体テスト用の `@tanstack/react-router` スタブ。ルーター実体は
// Cloudflare 依存を引き込むため、`Link` と `useRouter` だけを差し替える。
// 各テストにコピペしていた定型を SSOT 化したもの(jscpd の重複検出で
// CI が落ちるため、直接書かずここから import すること)。
//
// 使い方:
// ```ts
// vi.mock("@tanstack/react-router", async () => {
// 	const stub = await import("#/components/router-test-stub");
// 	return { Link: stub.StubLink, useRouter: stub.stubUseRouter };
// });
// ```
export function StubLink({
	children,
	to,
	params,
	...rest
}: {
	children?: ReactNode;
	to?: string;
	params?: Record<string, string>;
	// onClick 等の残りはそのまま <a> へ流す
	[key: string]: unknown;
}) {
	return createElement(
		"a",
		{
			href: to?.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? ""),
			...rest,
		},
		children,
	);
}

export function stubUseRouter() {
	return { invalidate: vi.fn() };
}
