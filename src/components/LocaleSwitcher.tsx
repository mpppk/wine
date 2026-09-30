import { useState } from "react";
import { authClient } from "#/lib/auth-client";
import { LOCALES, type LocaleKey, toLocaleKey } from "#/lib/locale";
import { getLocale, setLocale } from "#/paraglide/runtime.js";
import { setLocaleCookie } from "#/server/locale";
import { DropdownMenuItem } from "./ui/dropdown-menu";

// 言語名の表示は両ロケールで同じにする(利用者が読める言語で選べるように)。
const LOCALE_LABELS: Record<LocaleKey, string> = {
	ja: "日本語",
	en: "English",
};

/**
 * ヘッダーメニュー内のロケール切替(i18n Phase 1 #536)。
 *
 * 未ログインでも切り替えられる位置に置く(既定 ja 固定で Accept-Language を
 * 見ない以上、ここからしか英語に入れない)。`setLocale()` の既定挙動
 * (フルリロード)をそのまま使い、SSR との一貫性を保つ。
 *
 * ログイン時は user.locale へ保存する(preferredAiModel と同じ updateUser
 * 経路)。DB への保存と Cookie への書き戻し(server function)を終えてから
 * リロードする。
 */
export function LocaleSwitcher() {
	const { data: session } = authClient.useSession();
	const [pending, setPending] = useState(false);
	// 初期値は解決値そのものにする。SSR 時はリクエストの Cookie から、
	// クライアントでは document の Cookie から読むため、両者が一致して
	// ハイドレーションの不一致を起こさない。
	const [current, setCurrent] = useState<LocaleKey>(() => getLocale());

	async function handleSelect(next: LocaleKey) {
		if (next === current || pending) return;
		setPending(true);
		try {
			if (session?.user) {
				const saved = toLocaleKey(
					(session.user as { locale?: unknown }).locale,
				);
				// DB への保存は updateUser 経路(preferredAiModel と同じ)。
				if (saved !== next) {
					const result = await authClient.updateUser({ locale: next });
					if (result.error) throw new Error(result.error.message);
				}
				// Cookie の書き戻しはサーバが行う(user.locale 列のコメント参照)。
				// その後に setLocale() を呼んでも、Cookie が既に一致しているため
				// paraglide がリロードを省略してしまう(#430)ので、明示的に
				// フルリロードする(setLocale() の既定挙動と同じ見た目)。
				await setLocaleCookie({ data: { locale: next } });
				setCurrent(next);
				window.location.reload();
			} else {
				setCurrent(next);
				await setLocale(next);
			}
		} finally {
			setPending(false);
		}
	}

	return (
		<>
			{LOCALES.map((locale) => (
				<DropdownMenuItem
					key={locale}
					disabled={pending}
					aria-current={locale === current ? "true" : undefined}
					onSelect={() => {
						void handleSelect(locale);
					}}
				>
					<span className="flex w-full items-center justify-between gap-2">
						{LOCALE_LABELS[locale]}
						{locale === current && <span aria-hidden>✓</span>}
					</span>
				</DropdownMenuItem>
			))}
		</>
	);
}
