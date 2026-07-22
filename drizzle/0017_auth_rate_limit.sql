-- better-auth の永続レートリミット(rateLimit storage: "database")用テーブル(Issue #31)。
-- Cloudflare Workers は isolate ごとにメモリが分離し、既定のインメモリ storage が
-- 全 isolate でカウンタを共有できないため実効性が無い。レートリミットのカウンタを D1 に
-- 永続化することで、sign-in/sign-up/change-password/change-email のブルートフォースや
-- アカウント列挙・スパム登録を全 isolate 横断で抑止する。
-- カラムは better-auth の rateLimit モデル(key/count/lastRequest)に一致させる。
CREATE TABLE IF NOT EXISTS `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rate_limit_key_unique` ON `rate_limit` (`key`);
