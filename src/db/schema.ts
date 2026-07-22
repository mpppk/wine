import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import type { AdminAuditAction } from "#/lib/admin/audit";
import type { CreditLedgerType } from "#/lib/credit/types";
import { user } from "./auth-schema";

// ワイン学習アプリのドメインスキーマ。AOP等のコンテンツデータは静的ファイル
// (src/lib/wine/)で持ち、D1にはユーザ固有の学習状態のみを保存する。

/**
 * クイズ解答実績(ユーザ×問題キー)。問題は静的AOPデータから自動生成されるため
 * 問題テーブルは持たず、キー文字列(例 "variety:gamay:morgon")が表す
 * 「テストされる事実」単位で集計する。quizType/regionId はキーから導出可能だが、
 * 進捗ページの GROUP BY のために非正規化して持つ。
 */
export const quizQuestionStat = sqliteTable(
	"quiz_question_stat",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		questionKey: text("question_key").notNull(),
		quizType: text("quiz_type").notNull(),
		regionId: text("region_id").notNull(),
		correctCount: integer("correct_count").notNull().default(0),
		incorrectCount: integer("incorrect_count").notNull().default(0),
		/** 連続正解数(不正解で0にリセット)。直近の出来を表す */
		streak: integer("streak").notNull().default(0),
		lastAnsweredAt: integer("last_answered_at", {
			mode: "timestamp_ms",
		}).notNull(),
		lastCorrectAt: integer("last_correct_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	// 複合PKのインデックスが user_id 前方一致検索も担うため、単独indexは不要
	(table) => [primaryKey({ columns: [table.userId, table.questionKey] })],
);

/**
 * ユーザが飲んだワインの記録(マイセラー)。AOP・ブドウ品種は静的マスタ
 * (src/lib/wine/)への文字列参照でFKは張れないため、存在検証はサービス層で行う。
 * 写真は複数枚をR2(AVATARSバケット)にキー "wines/{userId}/{id}/{photoId}.{ext}" で
 * 保存し、photoKeys にそのキーの配列(表示順。先頭=代表サムネイル)を持つ。
 * (旧単一列 photo_key の既存データはマイグレーションで配列へ退避しており、
 * フラット形式の旧キーも配列内にそのまま入りうる。)
 */
export const drunkWine = sqliteTable(
	"drunk_wine",
	{
		/** crypto.randomUUID()。写真URLの推測不能性もこのIDに依存する */
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** 飲んだ日 "YYYY-MM-DD"(時刻不要のためtext) */
		drankOn: text("drank_on"),
		/** 静的AOPマスタの Aop.id(任意) */
		aopId: text("aop_id"),
		/** 1–5 */
		rating: integer("rating"),
		memo: text("memo"),
		/** ヴィンテージ(収穫年) */
		vintage: integer("vintage"),
		/** 静的品種マスタの GrapeVariety.id の配列 */
		grapeVarietyIds: text("grape_variety_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		producer: text("producer"),
		/** 円 */
		price: integer("price"),
		/** R2キーの配列。表示順で、先頭が代表(サムネイル)。空配列=写真なし */
		photoKeys: text("photo_keys", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		index("drunk_wine_user_created_idx").on(table.userId, table.createdAt),
	],
);

/**
 * 日次の学習活動サマリー(ユーザ×暦日)。quiz_question_stat は問題ごとに最新解答時刻
 * しか持たない(再解答で上書き)ため、日別の学習量・連続学習日数・履歴ヒートマップを
 * 正確に出せない。そこで解答1回ごとにこの表を JST の暦日単位でインクリメントする。
 * day は "YYYY-MM-DD"(JST)。drunk_wine.drankOn と同じく zone を持たない text-date。
 */
export const dailyActivity = sqliteTable(
	"daily_activity",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** JSTの暦日 "YYYY-MM-DD" */
		day: text("day").notNull(),
		/** その日の延べ解答数 */
		answeredCount: integer("answered_count").notNull().default(0),
		/** その日の延べ正解数 */
		correctCount: integer("correct_count").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.day] })],
);

/**
 * キャンペーンコードによる期間延長の引換記録。既存プレミアム会員が延長コードを
 * 入力すると Stripe サブスクの次回請求日を延長し、ここに1行記録する。
 * unique(userId, code) で「同一コードは会員ごとに1回」を保証し、多重送信・再利用を防ぐ。
 * 延長コードは Stripe のプロモコードではなくアプリ側で定義するため、FKは Stripe 側に張れない。
 */
export const couponRedemption = sqliteTable(
	"coupon_redemption",
	{
		/** crypto.randomUUID() */
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** 正規化済み(大文字)の入力コード */
		code: text("code").notNull(),
		/** このコードで延長した日数 */
		extendedDays: integer("extended_days").notNull(),
		redeemedAt: integer("redeemed_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		unique("coupon_redemption_user_code_uq").on(table.userId, table.code),
	],
);

/**
 * AIクレジットの増減を記録する追記専用台帳。付与(grant)/消費(consume)/返却(refund)を
 * すべて1行として残し、履歴・監査・二重計上防止を一枚岩で解く。残高そのものは
 * credit_balance にキャッシュし、この台帳とは db.batch で整合させて更新する。
 * amount は符号付きの「表示クレジット」(付与+ / 消費- / 返却+)、tokenAmount は
 * 内部精度の実測/見積トークン。requestId は冪等キーで、付与は grant:{userId}:{YYYY-MM}、
 * 消費・返却は予約IDから導出する。unique(requestId) が再送・二重付与を弾く。
 */
export const creditLedger = sqliteTable(
	"credit_ledger",
	{
		/** crypto.randomUUID() */
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** 符号付き表示クレジット。付与+ / 消費- / 返却+ */
		amount: integer("amount").notNull(),
		/** 台帳種別。値の定義は src/lib/credit/types.ts の CREDIT_LEDGER_TYPES が SSOT */
		type: text("type").notNull().$type<CreditLedgerType>(),
		/** 冪等キー。再送・二重付与を弾く */
		requestId: text("request_id").notNull(),
		/** 対象付与月 "YYYY-MM"(JST) */
		periodMonth: text("period_month").notNull(),
		/** 内部精度の実測/見積トークン(consume/refund時)。grant時はnull */
		tokenAmount: integer("token_amount"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		unique("credit_ledger_request_id_uq").on(table.requestId),
		index("credit_ledger_user_created_idx").on(table.userId, table.createdAt),
	],
);

/**
 * 現在残高のキャッシュ(台帳SUMの都度計算を避ける)。台帳追記と同一 db.batch で更新し
 * 常に整合させる。periodMonth はこの残高が属する付与月で、月が変わると付与時に balance を
 * その月の付与額へリセットする(繰越なし)。消費はこの balance を条件付きUPDATEで直接引く。
 */
export const creditBalance = sqliteTable("credit_balance", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	/** 現在残高(表示クレジット)。負にはならない(消費は balance>=n を条件に引く) */
	balance: integer("balance").notNull().default(0),
	/** この残高が属する付与月 "YYYY-MM"(JST) */
	periodMonth: text("period_month").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
});

/**
 * ユーザが村・畑・地方・シャトー(AOP)ごとに貼り付ける参考リンク(非公開)。
 * 例: シャンパーニュ「アンボネイ」を見ながら、webで見つけた解説記事のURLを保存する。
 * AOPは静的マスタ(src/lib/wine/)への文字列参照でFKは張れないため、aopIdの存在検証は
 * サービス層(reference-link-service)で getAop() により行う。1つのAOPに複数リンク可
 * (unique制約なし)。title はユーザ入力、未入力ならリンク先ページから自動取得した値
 * (取得失敗時は null で、表示側が URL/ホスト名で代替する)。
 */
export const aopReferenceLink = sqliteTable(
	"aop_reference_link",
	{
		/** crypto.randomUUID() */
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** 静的AOPマスタの Aop.id(スラッグ) */
		aopId: text("aop_id").notNull(),
		url: text("url").notNull(),
		/** 表示名。null なら表示側が URL/ホスト名で代替する */
		title: text("title"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	// 「このAOPの自分のリンク一覧」を引くための複合index
	(table) => [
		index("aop_reference_link_user_aop_idx").on(table.userId, table.aopId),
	],
);

/**
 * 監査ログ detail の型。action 固有の付随情報をフラットな JSON プリミティブの連想配列で持つ。
 * server fn のシリアライザが通るよう値は string/number/boolean/null に限定する(ネスト不可)。
 */
export type AdminAuditDetail = Record<string, string | number | boolean | null>;

/**
 * 管理操作の監査ログ(汎用)。管理画面からの価値のある/破壊的な操作(クレジット付与・
 * 期間延長・BAN・セッション失効 等)を1操作1行で追記記録する。actorUserId は操作した
 * 管理者、targetUserId は対象ユーザ。金銭的価値を扱う操作の証跡であり、ユーザ削除で
 * 消えては困るため user への FK は張らず userId 文字列参照で保持する
 * (subscription.referenceId と同方針)。detail は action 固有の付随情報
 * (例: クレジット付与なら {amount, requestId, periodMonth})を JSON で持つ。
 */
export const adminAuditLog = sqliteTable(
	"admin_audit_log",
	{
		/** crypto.randomUUID() */
		id: text("id").primaryKey(),
		/** 操作した管理者の user.id(FKなし=証跡保全) */
		actorUserId: text("actor_user_id").notNull(),
		/** 対象ユーザの user.id。ユーザに紐づかない操作は null(将来用) */
		targetUserId: text("target_user_id"),
		/** 操作種別。値の定義は src/lib/admin/audit.ts の ADMIN_AUDIT_ACTIONS が SSOT */
		action: text("action").notNull().$type<AdminAuditAction>(),
		/** action 固有の付随情報(JSON)。無い操作は null */
		detail: text("detail", { mode: "json" }).$type<AdminAuditDetail>(),
		/** 操作理由(クレジット付与など理由必須の操作で入力)。 */
		reason: text("reason"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		// 「対象ユーザの操作履歴」を新しい順に引くための複合index
		index("admin_audit_log_target_created_idx").on(
			table.targetUserId,
			table.createdAt,
		),
		// 「特定管理者の操作履歴」を引くための複合index
		index("admin_audit_log_actor_created_idx").on(
			table.actorUserId,
			table.createdAt,
		),
	],
);
