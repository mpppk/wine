import { createServerFn } from "@tanstack/react-start";
import { setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	LOCALE_COOKIE_MAX_AGE,
	LOCALE_COOKIE_NAME,
	type LocaleKey,
	localeKeySchema,
} from "#/lib/locale";
import * as userService from "#/lib/services/user-service";
import { authMiddleware } from "./middleware";

// ロケール Cookie のサーバ書き戻し(i18n Phase 1 #536)。
//
// user.locale 列は「保存先」であって「解決経路」ではない。実行時の解決は
// Cookie(wine_locale)だけを見る(paraglide の cookie strategy)ため、
// DB の値を Cookie へ写すのはこの2つの server function だけが行う
// (ログイン時と設定変更時。全SSRでD1を引かない)。

const localeInput = z.object({ locale: localeKeySchema });

function writeLocaleCookie(locale: LocaleKey): void {
	setCookie(LOCALE_COOKIE_NAME, locale, {
		path: "/",
		maxAge: LOCALE_COOKIE_MAX_AGE,
		sameSite: "lax",
	});
}

/**
 * 設定変更時の書き戻し。DB は `authClient.updateUser({ locale })`
 * (better-auth 経由)で更新し、Cookie はここで書く。両方を終えてから
 * クライアントが `setLocale()` でリロードする。
 */
export const setLocaleCookie = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(localeInput)
	.handler(async ({ data }): Promise<{ locale: LocaleKey }> => {
		writeLocaleCookie(data.locale);
		return { locale: data.locale };
	});

/**
 * ログイン時の書き戻し。別ブラウザでログインしても user.locale が Cookie へ
 * 復元される。DB 未設定・不正値なら何も書かず null を返す(既定 ja のまま)。
 */
export const syncLocaleCookie = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(async ({ context }): Promise<{ locale: LocaleKey | null }> => {
		const locale = await userService.getUserLocale(context.user.id);
		if (locale) writeLocaleCookie(locale);
		return { locale };
	});
