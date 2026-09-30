import { z } from "zod";

// 表示ロケールの単一情報源(i18n Phase 1 #536)。
//
// 対象言語は英語のみで、骨組み(解決経路・保存先・切替UI)を先に入れる。
// 日本語の表示は変えない。strategy は ["cookie", "baseLocale"]
// (project.inlang/paraglide.config.js と vite.config.ts)で、
// Cookie が無ければ ja(Accept-Language を見ない。SSR とハイドレーションで
// 解決結果がズレる余地を残さないため)。

/** 対応ロケール。paraglide の locales(["ja", "en"])と一致させる。 */
export const LOCALES = ["ja", "en"] as const;

/** ワイヤ上の値(クライアント⇄サーバ・D1保存値・Cookie値)。 */
export type LocaleKey = (typeof LOCALES)[number];

/** Cookie が無い・不正なときの既定ロケール。paraglide の baseLocale と一致させる。 */
export const DEFAULT_LOCALE: LocaleKey = "ja";

/** ロケール保持 Cookie 名。paraglide の cookieName と一致させる。 */
export const LOCALE_COOKIE_NAME = "wine_locale";

/** Cookie の有効期間(秒)。paraglide の既定(cookieMaxAge)と同じ 400 日。 */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

/**
 * ロケールキーの許可リスト検証スキーマ。**書き込み経路(better-auth の
 * additionalFields validator)と読み取り経路で共有する SSOT**
 * (#256 の regionQaModelKeySchema と同じ理由・同じ形)。エラーメッセージは
 * better-auth が 400 の message にそのまま載せ、プロフィール画面に
 * 表示されるため日本語にする。
 */
export const localeKeySchema = z.enum(LOCALES, {
	error: "対応していない言語です。",
});

/** 任意の値を許可リストと照合し、ロケールキーでなければ `null` を返す。 */
export function toLocaleKey(value: unknown): LocaleKey | null {
	const parsed = localeKeySchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
