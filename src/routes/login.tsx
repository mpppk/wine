import {
	createFileRoute,
	Link,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { getRouteSession } from "#/server/auth";
import { syncLocaleCookie } from "#/server/locale";

export const Route = createFileRoute("/login")({
	beforeLoad: async () => {
		const session = await getRouteSession();
		if (session) {
			throw redirect({ to: "/" });
		}
	},
	component: LoginPage,
});

function LoginPage() {
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [isPending, setIsPending] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setIsPending(true);
		const result = await authClient.signIn.email({ email, password });
		setIsPending(false);
		if (result.error) {
			setError(result.error.message ?? "Sign in failed");
		} else {
			// 別ブラウザで付けた言語設定を引き継ぐ(i18n Phase 1 #536)。
			// サーバが user.locale を Cookie へ書き戻した上で "/" へ遷移し、
			// シェルが復元後のロケールで再描画される。setLocale() による
			// リロードは要らない(書き戻し後の Cookie と一致して省略される)。
			await syncLocaleCookie();
			await router.navigate({ to: "/" });
		}
	};

	return (
		<main className="flex min-h-[calc(100vh-57px)] items-center justify-center px-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-2xl">Sign in</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								placeholder="you@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								type="password"
								placeholder="••••••••"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
							/>
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
						<Button type="submit" disabled={isPending} className="w-full">
							{isPending ? "Signing in..." : "Sign in"}
						</Button>
					</form>
				</CardContent>
				<CardFooter className="justify-center">
					<p className="text-center text-sm text-muted-foreground">
						Don't have an account?{" "}
						<Link to="/signup" className="text-primary hover:underline">
							Sign up
						</Link>
					</p>
				</CardFooter>
			</Card>
		</main>
	);
}
