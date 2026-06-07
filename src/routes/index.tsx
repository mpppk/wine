import { createFileRoute, redirect } from "@tanstack/react-router";
import { toNavigateOptions } from "#/lib/last-visited-destination";
import { getLastVisitedDestination } from "#/server/auth";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		const destination = await getLastVisitedDestination();
		throw redirect(toNavigateOptions(destination));
	},
});
