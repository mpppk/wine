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
import type { LabelEngineKey, LabelRoute } from "#/lib/ai/config";
import type { LabelJobStatus } from "#/lib/ai/label-job";
import type { CreditLedgerType } from "#/lib/credit/types";
import { DEFAULT_WINE_STATUS, type WineStatus } from "#/lib/drunk-wine/status";
import { DEFAULT_PLACE_KIND, type PlaceKind } from "#/lib/place/place";
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
 * ユーザのマイセラー(銘柄/ボトル)。AOP・ブドウ品種は静的マスタ
 * (src/lib/wine/)への文字列参照でFKは張れないため、存在検証はサービス層で行う。
 * 写真は複数枚をR2(AVATARSバケット)にキー "wines/{userId}/{id}/{photoId}.{ext}" で
 * 保存し、photoKeys にそのキーの配列(表示順。先頭=代表サムネイル)を持つ。
 * (旧単一列 photo_key の既存データはマイグレーションで配列へ退避しており、
 * フラット形式の旧キーも配列内にそのまま入りうる。)
 *
 * 飲んだ日・評価・メモの旧列(drank_on / rating / memo)は wine_tasting へ移して
 * drizzle/0019 で削除済み(Issue #205)。評価・メモは集計ではなく「最新1件の値」
 * なので非正規化せず、読み取り時に相関サブクエリで導出する。
 *
 * 所有状態(status)と飲用履歴(wineTasting の 1:N)は**直交する2軸**で持つ(Issue #195)。
 * 「以前飲んだワインをもう一度購入した」= status='owned' かつ 飲用記録あり、のように
 * 組み合わせがそのまま実際の状況に対応する。単一の enum に潰すとこれが表現できない。
 *
 * 目撃記録(wineSighting)は**第3の軸**(Issue #358)。「店で見かけた」は所有でも
 * 飲用でもないため既存2軸のどちらにも畳めない。同じワインを複数の店で見かけたら
 * 1エントリ + 目撃記録 × N になり、一括登録の distinct(重複統合)要件の受け皿になる。
 *
 * lastDrankOn / tastingCount(飲用)と lastSeenOn / sightingCount(目撃)は
 * それぞれの 1:N の集計キャッシュ。一覧・地図・ダッシュボードがいずれも
 * drunk_wine の単表クエリで、JOIN + GROUP BY にすると3経路すべてに波及するため
 * 非正規化する(dailyActivity と同じ理由付け)。更新は
 * recomputeDrunkWineAggregates(drunk-wine-service.ts)が4列まとめて全再計算で行い、
 * 飲用記録・目撃記録の書き換えと同一の db.batch に必ず含める。
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
		/** 所有状態。値のSSOTは src/lib/drunk-wine/status.ts */
		status: text("status")
			.notNull()
			.$type<WineStatus>()
			.default(DEFAULT_WINE_STATUS),
		/**
		 * 最新の飲用記録の飲んだ日 = max(wine_tasting.drank_on)。飲用記録が無い、
		 * または全件が日付未入力なら null。
		 */
		lastDrankOn: text("last_drank_on"),
		/** 飲用記録の件数。0 なら「まだ飲んだことがない」 */
		tastingCount: integer("tasting_count").notNull().default(0),
		/**
		 * 最新の目撃記録の見かけた日 = max(wine_sighting.seen_on)。目撃記録が無い、
		 * または全件が日付未入力なら null。
		 */
		lastSeenOn: text("last_seen_on"),
		/** 目撃記録の件数。0 なら「どこでも見かけていない」 */
		sightingCount: integer("sighting_count").notNull().default(0),
		/** 静的AOPマスタの Aop.id(任意) */
		aopId: text("aop_id"),
		/**
		 * 産地の粗い紐付け(AOPまで特定できないワイン用)。静的マスタの Region.id /
		 * WineCountry.id を参照する。aop_id とあわせて「最も細かい1つだけを保存する」
		 * 排他をサービス層で強制する(aop_id があれば両方 NULL、region_id があれば
		 * country_id は NULL。読み取り時は細→粗へ導出する)。
		 */
		regionId: text("region_id"),
		countryId: text("country_id"),
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
		/**
		 * 由来の一括登録バッチ(Issue #363 案A)。手動登録・単体登録では null。
		 * バッチ経由でも「既存エントリに目撃記録を足しただけ」(wine の指定が無い
		 * 一致項目)は null のまま——このエントリ自体は当該バッチで新規作成されて
		 * いないため。バッチ単位の取り消しは、この列を持つエントリだけを削除対象にする
		 * ことで、無関係な過去のデータ(目撃記録が増えただけの既存エントリ)を守る。
		 */
		batchId: text("batch_id").references(() => importBatch.id, {
			onDelete: "set null",
		}),
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
 * 飲用記録。1つの銘柄(drunkWine)を複数回飲んだ履歴を持つ(1:N)。同じワインを2回
 * 飲んで評価が違うのは当然なので、評価とメモは銘柄側ではなくここに属する。
 *
 * drankOn は nullable。「飲んだが日付を覚えていない」記録があり、旧データの移送でも
 * 日付未入力の行を飲用記録1件として作るため(取りこぼすと集計から消える)。
 *
 * userId は drunkWine 経由で辿れるが、所有権チェックを JOIN 無しの
 * `WHERE id AND userId` で行う規約(docs/architecture.md)のため冗長に持つ。
 */
export const wineTasting = sqliteTable(
	"wine_tasting",
	{
		id: text("id").primaryKey(),
		drunkWineId: text("drunk_wine_id")
			.notNull()
			.references(() => drunkWine.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/**
		 * 由来の一括登録バッチ。手動で足した試飲記録では null(#393)。
		 *
		 * **バッチ取り消しを対称にするために要る**。一括登録は既存エントリにも
		 * 試飲記録を足せるが、この列が無いと「バッチが足した試飲記録」を
		 * 特定できず、取り消しても残ってしまう(新規作成エントリぶんは
		 * drunk_wine 削除の FK cascade でたまたま消えていた)。
		 */
		batchId: text("batch_id").references(() => importBatch.id, {
			onDelete: "set null",
		}),
		/** 飲んだ日 "YYYY-MM-DD"。覚えていない場合は null */
		drankOn: text("drank_on"),
		/** 1–5 */
		rating: integer("rating"),
		memo: text("memo"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		index("wine_tasting_entry_drank_idx").on(table.drunkWineId, table.drankOn),
		index("wine_tasting_user_drank_idx").on(table.userId, table.drankOn),
	],
);

/**
 * 場所(ユーザ単位のマスタ)。「どの店でそのワインを見かけたか」を持つ(Issue #358)。
 *
 * **unique 制約を張らない**。同名の別店舗(チェーンの支店)は実在するし、
 * 「渋谷のあの店」のような曖昧な名前も許したい。表記ゆれの抑制は DB の制約ではなく
 * UI 側(既存 place をサジェストするコンボボックス)の仕事にする。制約で弾くと
 * 「登録できない」というエラーをユーザに見せることになり、記録の敷居が上がる。
 *
 * 静的マスタ(AOP・品種)と違い、これはユーザが自分で増やすデータなので D1 に置く
 * (docs/architecture.md「静的マスタと D1 ユーザ状態の分離」の後者)。
 */
export const place = sqliteTable(
	"place",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** 区分。値のSSOTは src/lib/place/place.ts */
		kind: text("kind").notNull().$type<PlaceKind>().default(DEFAULT_PLACE_KIND),
		memo: text("memo"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	// 一覧・サジェストが「自分の場所を名前順」で引くので、その形の複合index
	(table) => [index("place_user_name_idx").on(table.userId, table.name)],
);

/**
 * 一括登録1回ぶんの写真の保管単位(Issue #358)。レストランのワインリストや
 * ショップの棚を撮った写真は**1枚に数十銘柄が写る**ため、エントリごとに複製添付
 * するのは不適切。バッチに1回だけ置き、目撃記録(wineSighting)から photoIndex で
 * 参照する。drunk_wine.photoKeys はボトル写真用として独立のまま。
 *
 * **写真のR2キーは `wines/{userId}/{batchId}/{photoId}.{ext}`**。エントリ写真と
 * 同じ `wines/` 接頭辞に載せるのは、非公開画像の認可・署名URL・退会時の一括削除が
 * すべてこのレイアウトを前提に書かれているため(images/signed-url.ts の
 * ownerOfPrivateImageKey / privateImagePrefixForUser、routes/api/images/$.ts の
 * isAllowedImageKey、user-deletion-service の R2 掃除)。専用接頭辞を新設すると
 * この4箇所を同時に広げる必要があり、1つでも漏らすと
 * docs/architecture.md が警告する「所有者判定と削除範囲のズレで、消したはずの
 * 個人データがR2に残る」に直行する。batchId も drunkWine.id も
 * crypto.randomUUID() なので、中間セグメントの名前空間は衝突しない。
 */
export const importBatch = sqliteTable(
	"import_batch",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** 撮影した場所。任意(場所を入力せずに一括登録できる) */
		placeId: text("place_id").references(() => place.id, {
			onDelete: "set null",
		}),
		/** 見かけた日 "YYYY-MM-DD"。バッチ内の目撃記録の既定値になる */
		seenOn: text("seen_on"),
		/** R2キーの配列。撮影順(photoIndex がこの配列の添字) */
		photoKeys: text("photo_keys", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		/**
		 * 登録時に申告された写真の枚数(#405)。**2段階目のアップロードで
		 * 「申告どおりの枚数が来たか」を検証するために要る**。
		 *
		 * 目撃記録は photoIndex でこの配列を指すので、申告より少ない枚数が入ると
		 * 添字が範囲外になる(写真が出ない)か、**別の写真を指す**(前段が抜けて
		 * 後続が繰り上がる)。登録時の zod も `photoIndex < photoCount` を見ているが、
		 * その値がここに残っていないと後段は同じ前提を確認できない。
		 *
		 * `null` は **この列を持つ前に作られた既存バッチ**を意味し、その場合は
		 * 検証をスキップする(申告枚数は遡って復元できない)。
		 */
		photoCount: integer("photo_count"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("import_batch_user_created_idx").on(table.userId, table.createdAt),
	],
);

/**
 * 目撃記録。1つの銘柄(drunkWine)を複数の場所で見かけた履歴を持つ(1:N)。
 * wineTasting と同じ流儀で、所有状態・飲用履歴と直交する第3の軸(Issue #358)。
 *
 * - レストランAで見かけて飲んだ → エントリ + 目撃記録(A) + 飲用記録
 * - ショップB・Cで見かけた同一ワイン → 1エントリ + 目撃記録(B) + 目撃記録(C)
 * - 以前飲んだワインを店で見かけた → 既存エントリに目撃記録が増えるだけ
 *
 * seenOn は nullable。wineTasting.drankOn と同じく「見かけたが日付を覚えていない」
 * 記録を取りこぼすと集計から消えるため。
 *
 * price は銘柄側(drunk_wine.price)とは別物で「その店での売値」。店ごとに違うのが
 * 当たり前なのでここに属する(評価・メモが飲用記録に属するのと同じ理由)。
 *
 * userId は drunkWine 経由で辿れるが、所有権チェックを JOIN 無しの
 * `WHERE id AND userId` で行う規約(docs/architecture.md)のため冗長に持つ。
 */
export const wineSighting = sqliteTable(
	"wine_sighting",
	{
		id: text("id").primaryKey(),
		drunkWineId: text("drunk_wine_id")
			.notNull()
			.references(() => drunkWine.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** 見かけた場所。任意。場所を消しても目撃した事実は残すので set null */
		placeId: text("place_id").references(() => place.id, {
			onDelete: "set null",
		}),
		/** 由来の一括登録バッチ。手動で足した目撃記録では null */
		batchId: text("batch_id").references(() => importBatch.id, {
			onDelete: "set null",
		}),
		/** バッチの photoKeys の添字(0始まり)。どの写真に写っていたか */
		photoIndex: integer("photo_index"),
		/** 見かけた日 "YYYY-MM-DD"。覚えていない場合は null */
		seenOn: text("seen_on"),
		/** その店での売値(円) */
		price: integer("price"),
		memo: text("memo"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		index("wine_sighting_entry_seen_idx").on(table.drunkWineId, table.seenOn),
		index("wine_sighting_user_seen_idx").on(table.userId, table.seenOn),
		// 「この店で見かけたワイン一覧」(PR4)用。所有権の user_id を先頭に置く
		index("wine_sighting_user_place_idx").on(table.userId, table.placeId),
	],
);

/**
 * 日次の学習活動サマリー(ユーザ×暦日)。quiz_question_stat は問題ごとに最新解答時刻
 * しか持たない(再解答で上書き)ため、日別の学習量・連続学習日数・履歴ヒートマップを
 * 正確に出せない。そこで解答1回ごとにこの表を JST の暦日単位でインクリメントする。
 * day は "YYYY-MM-DD"(JST)。wine_tasting.drankOn と同じく zone を持たない text-date。
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
 * amount は符号付きの「表示クレジット」(付与+ / 消費- / 返却+)で、**1クレジット =
 * $0.001 の量子化された実原価**(#355)。costMicroUsd は量子化前の実原価、tokenAmount は
 * トークン数で、どちらも課金の根拠ではなく観測値。requestId は冪等キーで、付与は
 * grant:{userId}:{YYYY-MM}、消費・返却は予約IDから導出する。
 * unique(requestId) が再送・二重付与を弾く。
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
		/** 実測/見積トークン(consume/settle時)。grant時はnull。観測値で課金の根拠ではない */
		tokenAmount: integer("token_amount"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		/**
		 * 量子化前の実原価(µUSD)。**列の順序を変えないこと**: `reserveCredits` と
		 * `reservationMarkerInsert` の `INSERT ... SELECT` はテーブル定義と同じ列順・
		 * 列数を要求し、`drizzle/0025` の `ALTER TABLE ADD COLUMN` は物理的に末尾へ
		 * 足すので、ここは createdAt より後ろでなければならない。
		 *
		 * トークン基準で計上していた頃(#355 以前)の行は null。
		 */
		costMicroUsd: integer("cost_micro_usd"),
	},
	(table) => [
		unique("credit_ledger_request_id_uq").on(table.requestId),
		index("credit_ledger_user_created_idx").on(table.userId, table.createdAt),
		// 障害補填(#116)の対象抽出 findConsumersInRange は type='consume' AND created_at
		// BETWEEN で検索する。user_id 先頭の索引では効かず全表走査になるため専用の索引を張る(#164)。
		index("credit_ledger_type_created_idx").on(table.type, table.createdAt),
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
 * エチケット解析の非同期ジョブ(Issue #460)。「投入したらページを離れてよく、後から
 * 完了が分かる」ための状態の置き場。
 *
 * **クライアントには置けない**。ページを閉じた時点でエージェントループを進める主体が
 * 消えるため、写真(R2)・状態(この表)・進行のすべてをサーバが持つ以外に選択肢が無い。
 * 画像そのものは D1 に入れず、R2キーだけをここに持つ(`wines/{userId}/{jobId}/…`。
 * マイセラー写真と同じ接頭辞に載せることで、非公開画像の認可・署名URL・退会時の一括削除が
 * そのまま効く。専用接頭辞の新設はその4箇所の同時拡張を要求する。import_batch と同じ判断)。
 *
 * クレジットは**投入時に予約**し、コンシューマが実測で確定する(runMeteredInference を
 * begin/finish に開いたのはこのため)。行が存在する = 予約は成立している、が不変条件で、
 * 残高不足は行を作らず投入APIがその場で返す。
 */
export const labelAnalysisJob = sqliteTable(
	"label_analysis_job",
	{
		/** crypto.randomUUID()。R2キーの推測不能性もこのIDに依存する */
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** 状態。値のSSOTは src/lib/ai/label-job.ts の LABEL_JOB_STATUSES */
		status: text("status").notNull().$type<LabelJobStatus>().default("queued"),
		/** 解析対象のR2キー(撮影順)。終端に到達した時点で削除するので、その後は空配列 */
		photoKeys: text("photo_keys", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		/**
		 * 申告枚数。`photoKeys` は完了後に空になるため、実行記録の photoCount と
		 * 見積の再計算にはこちらを使う(枚数は経路の単価に効く)。
		 */
		photoCount: integer("photo_count").notNull(),
		/**
		 * クレジット台帳の request_id(予約の冪等キー)。settle / refund はここから導出
		 * されるので、ジョブと台帳を突き合わせる唯一のキーでもある。
		 */
		requestId: text("request_id").notNull(),
		/** 予約した表示クレジット。確定・返却に必要 */
		reservedCredits: integer("reserved_credits").notNull(),
		/** 予約した原価(µUSD)。実測が取れなかった回の床の計算に使う */
		reservedMicroUsd: integer("reserved_micro_usd").notNull(),
		/** ユーザがプロフィールで選んでいたエンジン。実行記録の selected に載る */
		selectedEngine: text("selected_engine").notNull().$type<LabelEngineKey>(),
		/** 予約時に解決した実行経路。**コンシューマは再解決せずこれを使う**(予約と食い違わせない) */
		route: text("route").notNull().$type<LabelRoute>(),
		/** 成功時の自動入力候補(LabelSuggestions)。未完了・失敗なら null */
		suggestions: text("suggestions", { mode: "json" }).$type<unknown>(),
		/** 成功時の実測トークン。観測値で課金の根拠ではない */
		actualTokens: integer("actual_tokens"),
		/** 失敗時の利用者向け文言。詳細(モデル都合の例外)はサーバ側のログにだけ残す */
		error: text("error"),
		/** `running` に遷移した時刻。LABEL_JOB_STALE_MS の起点 */
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		/** 終端(succeeded/failed)に到達した時刻 */
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
		/**
		 * 利用者が結果を画面で受け取った時刻(#462)。null = 未受け取り。
		 *
		 * **`status` とは別の軸**。status は「推論がどうなったか」で、こちらは「その結果を
		 * もう見せなくてよいか」。混ぜると `isTerminalLabelJobStatus` の意味が二重になり、
		 * ポーリングの停止条件が濁る。マイセラーの完了バッジは
		 * `status = 'succeeded' AND consumed_at IS NULL` を数える。
		 */
		consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		// 予約の冪等キーと1対1。二重投入で同じ予約に2つのジョブがぶら下がらない
		unique("label_analysis_job_request_id_uq").on(table.requestId),
		// 「このユーザの未終端ジョブ」(同時実行上限・stale の走査)と「最近のジョブ一覧」
		index("label_analysis_job_user_status_idx").on(table.userId, table.status),
		index("label_analysis_job_user_created_idx").on(
			table.userId,
			table.createdAt,
		),
	],
);

/**
 * Web Push の購読(Issue #466)。1ユーザ×複数端末なので 1:N。
 *
 * **`endpoint` が購読の同一性**。同じブラウザで再購読すると同じ endpoint が返るので、
 * ここに unique を張って upsert の衝突先にする(同じ端末へ2通送らない)。
 *
 * 鍵(`p256dh` / `auth`)はブラウザの `PushSubscription.getKey()` から取る、その購読へ
 * 送るためだけの値。他の購読やユーザには流用できない。
 */
export const pushSubscription = sqliteTable(
	"push_subscription",
	{
		/** crypto.randomUUID() */
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** プッシュサービスのURL。購読の同一性はこれで決まる */
		endpoint: text("endpoint").notNull(),
		/** RFC 8291 の受信側公開鍵(base64url) */
		p256dh: text("p256dh").notNull(),
		/** RFC 8291 の共有秘密(base64url) */
		auth: text("auth").notNull(),
		/** 購読した端末の目安(User-Agent の抜粋)。複数端末を見分ける表示用 */
		userAgent: text("user_agent"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		/** 最後に送信が成功した時刻。送れていない購読の棚卸し用 */
		lastNotifiedAt: integer("last_notified_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		unique("push_subscription_endpoint_uq").on(table.endpoint),
		index("push_subscription_user_idx").on(table.userId),
	],
);

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
