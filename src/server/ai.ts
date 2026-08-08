import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AI_MAX_QUESTION_CHARS, chatHistorySchema } from "#/lib/ai/config";
import { pushSubscriptionInputSchema } from "#/lib/push/notification";
import * as aiService from "#/lib/services/ai-service";
import * as labelJobService from "#/lib/services/label-job-service";
import * as pushService from "#/lib/services/push-service";
import { authMiddleware } from "./middleware";

// 地域チャットQ&AのRPC。Workers AI で回答し、実測トークンでクレジットを消費する。認証必須。
// 会話履歴はクライアントが保持し毎ターン渡す(サーバはステートレス)。
// 使うモデルはユーザのプロフィール設定(preferredAiModel)からサーバ側で解決するため、
// リクエストでは受け取らない。
export const askRegion = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			regionId: z.string().min(1),
			aopId: z.string().min(1).optional(),
			question: z.string().trim().min(1).max(AI_MAX_QUESTION_CHARS),
			// 境界の定義はドメイン lib と共有する(MCP 層と食い違わせない。#340)
			history: chatHistorySchema.optional(),
		}),
	)
	.handler(({ data, context }) =>
		aiService.answerRegionQuestion(context.user.id, data),
	);

/**
 * 写真からの一括登録(Issue #358)で**実際に走る経路**。使えない環境では `null`。
 *
 * この経路は Workers AI へフォールバックしない(#358)ため、`OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` のどちらも無い環境では**導線ごと隠す**。解決の実体は ai-service
 * 側と同じ関数で、UI の出し分けとサーバの 503 が食い違わないようにする。
 *
 * 経路まで返すのは、解析前に必要クレジットを表示するため(#426)。GPT-5.6 Luna と
 * Claude Sonnet 5 では単価が桁で違い、経路はシークレットの設定状況とユーザ設定に
 * 依存するのでクライアントでは決められない(`getLabelAnalysisPlan` と同じ理由)。
 */
export const getWineListAnalysisPlan = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => ({
		route: await aiService.resolveWineListRouteForUser(context.user.id),
	}));

/**
 * エチケット解析で**実際に走る経路**と、高精度経路の利用可否。
 *
 * 解析前に必要クレジットを表示するために要る(#355)。コスト基準の計上では経路によって
 * 消費が 3 / 39 / 275 クレジットと2桁変わるので、押してから残高不足で弾かれると
 * 「なぜ足りないのか」が分からない。経路はシークレットの設定状況に依存し
 * クライアントでは決められないため、サーバから返す。
 */
export const getLabelAnalysisPlan = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => ({
		route: await aiService.resolveLabelRouteForUser(context.user.id),
		availability: aiService.labelProviderAvailability(),
	}));

/**
 * エチケット解析ジョブ1件の状態を返す(#462)。**読み取り専用**。
 *
 * 登録画面(`/cellar/new?labelJob=<jobId>`)のローダーが使う。SSR の時点で候補が
 * 初期値に入るので、フォームが空でマウントしてから埋まる一瞬が見えない。
 *
 * **ここで既読化してはいけない**。ルータは `defaultPreload: "intent"` なので、
 * リンクにホバーしただけでローダーが走る。既読化を混ぜると「バッジのボタンに触れただけで
 * 完了が消え、結果はURLを知らないと二度と開けない」ことになる(#462 の実機確認で実際に
 * 起きた)。ローダーは副作用を持たない。
 */
export const getLabelAnalysisJobById = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ jobId: z.string().min(1).max(80) }))
	.handler(async ({ data, context }) =>
		labelJobService.getLabelAnalysisJob(context.user.id, data.jobId),
	);

/**
 * 完了したエチケット解析ジョブを受け取り済みにする(#462)。
 *
 * **画面がマウントされてから**クライアントが1回だけ呼ぶ。既読化は「利用者が実際に結果を
 * 見た」ことの記録なので、ローダー(= ホバーで走りうる)ではなくここで行う。
 * 2回目以降は `alreadyConsumed: true` になるだけで候補は同じものが返る(冪等)。
 */
export const consumeLabelAnalysisJob = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ jobId: z.string().min(1).max(80) }))
	.handler(async ({ data, context }) =>
		labelJobService.consumeLabelAnalysisJob(context.user.id, data.jobId),
	);

/**
 * 解析結果の宛先エントリを記録する(#472)。
 *
 * 記録フォームが**保存に成功した直後**に呼ぶ。走行中のジョブが完了したとき、その結果を
 * 新規登録として受け取ると同じワインが2件できるため、保存先をジョブ側に残して受け取りを
 * 「そのワインを編集」へ振り分けられるようにする。
 *
 * 呼び出しは best-effort。失敗しても保存済みのエントリには影響が無く、受け取りが
 * 従来どおり新規作成モードへ落ちるだけなので、クライアント側は例外を握って構わない。
 */
export const attachLabelAnalysisJobEntry = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			jobId: z.string().min(1).max(80),
			entryId: z.string().min(1).max(80),
		}),
	)
	.handler(async ({ data, context }) =>
		labelJobService.attachLabelAnalysisJobEntry(
			context.user.id,
			data.jobId,
			data.entryId,
		),
	);

/**
 * 一括抽出に使った写真を、その結果から作ったバッチへ引き継ぐ(#474)。
 *
 * レビュー画面が**登録に成功した直後**に呼ぶ。ジョブ化で離脱・復帰した回は手元に
 * `File` が無いので、アップロードの代わりにこれを通る。best-effort(失敗しても登録
 * そのものは済んでいる)。
 */
export const adoptLabelJobPhotosToBatch = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			jobId: z.string().min(1).max(80),
			batchId: z.string().min(1).max(80),
		}),
	)
	.handler(async ({ data, context }) =>
		labelJobService.adoptLabelJobPhotosToBatch(
			context.user.id,
			data.jobId,
			data.batchId,
		),
	);

// ---- Web Push の購読(Issue #466) ----
//
// エチケット解析の完了通知に使う。**通知は付随物**なので、購読の失敗が解析の導線を
// 妨げないようにサーバfn側でも例外を投げる範囲を最小にしてある。

/**
 * この環境で Web Push が使えるか、公開鍵、いま購読済みか。
 * **UI の出し分けとサーバの送信が同じ判定(`isWebPushConfigured`)を見る**ようにする。
 */
export const getPushStatus = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => ({
		publicKey: pushService.webPushPublicKey(),
		subscribed: await pushService.hasPushSubscription(context.user.id),
	}));

/** 購読を登録する(同じ endpoint は上書き)。 */
export const savePushSubscription = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(pushSubscriptionInputSchema)
	.handler(async ({ data, context }) => {
		await pushService.savePushSubscription(context.user.id, data);
		return { ok: true } as const;
	});

/** 購読を解除する(本人のもののみ)。存在しない endpoint も成功扱い(冪等)。 */
export const deletePushSubscription = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ endpoint: z.string().min(1).max(2000) }))
	.handler(async ({ data, context }) => {
		await pushService.deletePushSubscription(context.user.id, data.endpoint);
		return { ok: true } as const;
	});
