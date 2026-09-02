import { z } from "zod";

/** Supported UI locales. Keep this allowlist in sync with project.inlang. */
export const LOCALES = ["ja", "en"] as const;
export const BASE_LOCALE = "ja" satisfies (typeof LOCALES)[number];
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

/** Return a supported locale, or undefined for untrusted/legacy values. */
export function toLocale(value: unknown): Locale | undefined {
	return typeof value === "string" && LOCALES.includes(value as Locale)
		? (value as Locale)
		: undefined;
}
