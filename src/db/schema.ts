import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
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
 * 写真はR2(AVATARSバケット)にキー "wines/{userId}/{id}.{ext}" で保存し、
 * photoKey にそのキーを持つ。
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
		photoKey: text("photo_key"),
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
