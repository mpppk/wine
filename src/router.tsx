import {
	createRouter as createTanStackRouter,
	type ErrorComponentProps,
	Link,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { useEffect } from "react";
import { getContext } from "./integrations/tanstack-query/root-provider";
import {
	initClientErrorReporting,
	reportClientError,
} from "./lib/observability/client-error";
import { routeTree } from "./routeTree.gen";

// クライアントのエラー収集を開始する(Issue #381)。`import.meta.env.SSR` はビルド時に
// 定数畳み込みされるので、**SSR(workerd)バンドルにはこの行ごと残らない**。
// ブラウザ専用SDKが Worker 側へ混ざると起動ごと壊れるため、この形は必須。
if (!import.meta.env.SSR) void initClientErrorReporting();

const homeButtonClass =
	"rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90";

// ルート全体の既定エラー画面。loader/コンポーネントの例外(D1障害・500化した
// 認証エラー等)で、フレームワーク素の開発者向け表示ではなくスタイル付きの案内 +
// 再試行/トップ導線を出す。クライアント側エラー収集の受け口でもある(#381)。
function DefaultErrorComponent({ error, reset }: ErrorComponentProps) {
	useEffect(() => {
		reportClientError(error, {
			kind: "route",
			pathname: window.location.pathname,
		});
	}, [error]);
	return (
		<main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
			<h1 className="text-xl font-bold">エラーが発生しました</h1>
			<p className="text-sm text-muted-foreground">
				時間をおいて再度お試しください。問題が続く場合はトップへ戻ってください。
			</p>
			<div className="flex gap-3">
				<button
					type="button"
					onClick={() => reset()}
					className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
				>
					再試行
				</button>
				<Link to="/" className={homeButtonClass}>
					トップへ戻る
				</Link>
			</div>
		</main>
	);
}

// 存在しないパスの既定表示。スタイルなしのデフォルト NotFound を避ける。
function DefaultNotFoundComponent() {
	return (
		<main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
			<h1 className="text-xl font-bold">ページが見つかりません</h1>
			<p className="text-sm text-muted-foreground">
				お探しのページは存在しないか、移動した可能性があります。
			</p>
			<Link to="/" className={homeButtonClass}>
				トップへ戻る
			</Link>
		</main>
	);
}

export function getRouter() {
	const context = getContext();

	const router = createTanStackRouter({
		routeTree,
		context,
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		defaultErrorComponent: DefaultErrorComponent,
		defaultNotFoundComponent: DefaultNotFoundComponent,
	});

	setupRouterSsrQueryIntegration({ router, queryClient: context.queryClient });

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
