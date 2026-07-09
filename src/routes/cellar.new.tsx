import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { DrunkWineForm } from "#/components/cellar/DrunkWineForm";
import { Button } from "#/components/ui/button";
import { getSession } from "#/server/auth";

export const Route = createFileRoute("/cellar/new")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	component: CellarNewPage,
});

function CellarNewPage() {
	const navigate = useNavigate();

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<div className="mb-6 flex items-center gap-2">
				<Button
					asChild
					variant="ghost"
					size="icon"
					aria-label="マイセラーへ戻る"
				>
					<Link to="/cellar">
						<ArrowLeftIcon className="size-4" />
					</Link>
				</Button>
				<h1 className="text-2xl font-bold">ワインを記録</h1>
			</div>
			<DrunkWineForm
				onSaved={() => {
					void navigate({ to: "/cellar" });
				}}
			/>
		</main>
	);
}
