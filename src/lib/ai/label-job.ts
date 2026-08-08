import { z } from "zod";

// エチケット解析ジョブの語彙と定数(Issue #460)。
//
// **なぜジョブ化するか**: エージェントループ(#458/#459)は写真の拡大・再検索を挟むため
// 1リクエストで完結させるには長い(実測30秒前後)。加えて「投入したらページを離れたい」
// という要求があり、これが決定的に**クライアントが状態を持つ方式を排除する**——
// ページを閉じた時点でループを進める主体が消えるため、サーバが写真・状態・進行の
// すべてを持つ以外に選択肢がない。
//
// このファイルは `cloudflare:workers` に依存しない純粋な語彙だけを置く(unit プロジェクト
// から読めるようにするため)。D1・R2・キューに触る実装は label-job-service.ts。

/**
 * ジョブの状態。**`blocked`(残高不足)は含まない**: 予約は投入APIの中で同期に行い、
 * 足りなければジョブ行を作らずその場で返す。行が存在する = 予約は成立している。
 *
 * 遷移は `queued → running → succeeded | failed` の一方向のみ。`succeeded` / `failed`
 * が終端で、そこから戻ることはない(再実行は新しいジョブになる)。
 */
export const LABEL_JOB_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
] as const;

export type LabelJobStatus = (typeof LABEL_JOB_STATUSES)[number];

/** 終端状態か(= UI がポーリングを止めてよいか)。 */
export function isTerminalLabelJobStatus(status: LabelJobStatus): boolean {
	return status === "succeeded" || status === "failed";
}

/**
 * 解析ジョブの種別(#474)。**同じ器に載せる**理由は 0032 のマイグレーションに書いた。
 *
 *  - `label`: エチケット解析。1ジョブ = 1本ぶんの `LabelSuggestions`
 *  - `wine_list`: 一括抽出。1ジョブ = N銘柄の候補配列 + サマリ
 *
 * 違うのは**推論の中身と結果の形だけ**で、予約・写真・状態機械・受け取りは共通。
 */
export const LABEL_JOB_KINDS = ["label", "wine_list"] as const;

export type LabelJobKind = (typeof LABEL_JOB_KINDS)[number];

/** 既定の種別。列のデフォルトと一致させる(既存行はこれで埋まっている)。 */
export const DEFAULT_LABEL_JOB_KIND: LabelJobKind = "label";

/**
 * キューに載せるメッセージ。**ジョブIDだけ**を載せる。
 *
 * 理由は2つ:
 *  1. 写真はキューのメッセージ上限(128KB)に収まらない
 *  2. キューは at-least-once なので同じメッセージが再配信されうる。本体をメッセージに
 *     載せると、再配信で**古い内容が復活する**。常に D1 の最新行から読めばその窓が無い
 */
export interface LabelJobMessage {
	jobId: string;
}

/**
 * 受信したメッセージの検証。キューの本文は「以前のデプロイが積んだ古い形」でも届きうる
 * ので、コンシューマ側で形を確かめてから使う(形が違えば ack して捨てる)。
 */
export const labelJobMessageSchema = z.object({
	jobId: z.string().min(1),
});

/**
 * 1ユーザが同時に持てる未終端ジョブ(`queued` + `running`)の上限。
 *
 * **予約は投入時に立つ**ので、連投されると残高が予約で埋まり、本人の他のAI機能まで
 * 残高不足でブロックされる。同期経路には「1リクエスト = 1解析」という自然な上限が
 * あったが、投げっぱなしにできるジョブ経路にはそれが無いので明示的に設ける。
 */
export const MAX_CONCURRENT_LABEL_JOBS = 3;

/**
 * `running` のまま放置されたジョブを失敗として決着させるまでの時間。
 *
 * コンシューマは予告なく死ぬ(コンテナ回収・デプロイ・ランタイムの打ち切り)。決着させ
 * ないと UI が永久にポーリングし、`MAX_CONCURRENT_LABEL_JOBS` の枠も空かない。
 *
 * 値は「エージェントループの実測(30秒前後)+ ステップ上限まで回った場合の余裕」から
 * 取る。短すぎると**生きているジョブを失敗にして**しまい(そのジョブはこの後 succeeded を
 * 書こうとして claim ガードに弾かれる)、長すぎると枠が空かない。
 *
 * **credit-service の `ORPHAN_GRACE_MS`(10分)より長くする**。stale 決着はクレジットを
 * 返さない(回収は `reclaimOrphanReservations` に一本化する #246)ので、決着した時点で
 * その予約が**既に回収の対象年齢に達している**必要がある。短くすると「ジョブは失敗表示
 * なのに、予約はまだ猶予期間内で回収されない」窓ができ、利用者の残高が戻るまでの間が
 * 無用に伸びる。
 */
export const LABEL_JOB_STALE_MS = 15 * 60 * 1000;

/**
 * `queued` のまま配信されなかったジョブを決着させるまでの時間。
 *
 * Queues のリトライを待つぶん `running` より長く取る。ここに掛かるのはキューが
 * メッセージを取りこぼした場合だけで、通常は数秒で `running` に移る。
 */
export const LABEL_JOB_QUEUE_STALE_MS = 30 * 60 * 1000;

/**
 * 成功したジョブの写真を、引き継がれないまま保持しておく期間(#474)。
 *
 * 解析に使った写真はその結果を記録するワインの写真になるので終端では消さないが、
 * **引き取り手が現れなかった回**は R2 に残り続ける。受け取り済み(`consumed_at`)からの
 * 経過で測るのは、そこが「利用者は結果を見た」= 記録するかどうかを決められる状態に
 * なった時点だから。
 *
 * 24時間にしてあるのは、受け取った直後に記録しない使い方(候補を見てから写真を撮り直す・
 * 翌日まとめて入力する)を潰さないため。短くすると、戻ってきたときに写真だけが消えている。
 */
export const LABEL_JOB_PHOTO_RETENTION_MS = 24 * 60 * 60 * 1000;

/** ジョブが `running` を超過して打ち切られたときの、利用者向けの文言。 */
export const LABEL_JOB_STALE_ERROR_MESSAGE =
	"解析が時間内に完了しませんでした。写真を選び直してもう一度お試しください。";

/** 推論が失敗したときの、利用者向けの文言。詳細はサーバ側のログにだけ残す。 */
export const LABEL_JOB_FAILED_ERROR_MESSAGE = "エチケットの解析に失敗しました";
