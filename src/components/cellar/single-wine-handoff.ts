import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import { valuesFromSuggestions } from "#/components/cellar/import-candidates";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import { DEFAULT_WINE_STATUS } from "#/lib/drunk-wine/status";
import type { WineListAnalysisSummary } from "#/lib/services/ai-service";

// 写真からの登録(/cellar/new)で、写真のウィザードから単体の記録フォームへ
// 切り替えるときに渡す荷物と、「写っているのは1本のワインのエチケットだった」の
// 判定(Issue #416)。
//
// 判定は **AIの被写体判定(subject) と 抽出銘柄が1件であること の両方**を要求する。
// subject だけだと「1本のつもりで撮った棚の写真」から他の銘柄が黙って落ち、件数だけ
// だと「1銘柄しか読めなかったワインリスト」まで単体登録へ飛ばしてしまう。
//
// 以前は /cellar/import から /cellar/new への**遷移**をまたぐ受け渡しで、荷物に
// File が含まれるため history.state を使えず、モジュールスコープの箱で渡していた。
// 登録画面を /cellar/new に統合した今は同一画面内のモード切り替えなので、荷物は
// 素直に state として持てる(箱は不要になった)。

/** 引き継げる写真の枚数。エントリ1件の上限(6枚)で、一括登録の上限(10枚)より小さい。 */
export const MAX_HANDOFF_PHOTOS = MAX_PHOTOS_PER_ENTRY;

/** 単体の記録フォームへ切り替えた理由。案内文とエチケット解析の自動実行を分ける。 */
export type ManualFormReason =
	/** 解析結果が1本のワインのエチケットだった(自動で切り替わる) */
	| "single_wine"
	/** ユーザが「手動で入力」を選んだ */
	| "manual_choice"
	/**
	 * 完了したエチケット解析ジョブを受け取って開いた(#462)。**`single_wine` と分ける**の
	 * は、あちらが「これから解析する」のに対しこちらは「解析済みの結果を持って来ている」
	 * ため。混ぜると案内文が嘘になり、`autoAnalyzeLabel` がもう一度クレジットを使う
	 * 解析を走らせる条件にも入ってしまう。
	 */
	| "label_job";

/** 単体の記録フォームへ渡す荷物。 */
export interface ManualFormStart {
	/**
	 * フォームの初期値(解析で読み取った内容)。「手動で入力」では解析を経ていないので
	 * 未指定になり、フォームは空で開く。
	 */
	values?: DrunkWineFieldsValue;
	/** フォームに添付済みにする写真(先頭 MAX_HANDOFF_PHOTOS 枚)。 */
	files: File[];
	/** 引き継げず落とした写真の枚数。0 なら全部引き継げている。 */
	droppedPhotoCount: number;
	reason: ManualFormReason;
	/**
	 * 写真の場所・撮影日を入力済みのまま切り替えたか。記録フォームには目撃記録の
	 * 入力欄が無く引き継げないので、true のときはその旨を画面で知らせる。
	 */
	discardedSightingInput: boolean;
}

/**
 * 単一ワインとして扱える解析結果か判定し、扱えるならその候補を返す。
 * 扱えない(= 一括登録のレビューを続けるべき)場合は null。
 */
export function singleWineCandidate(
	candidates: WineListCandidate[],
	summary: WineListAnalysisSummary,
): WineListCandidate | null {
	if (summary.subject !== "single_wine") return null;
	// 「1本のワインの写真」なのに複数銘柄が読めた回は、判定のほうを疑う。
	// 一括レビューなら全件を確認できるので、迷ったら情報量の多い側に倒す。
	if (candidates.length !== 1) return null;
	// 既存セラーに同じ銘柄がある場合も候補にはする(切り替え後にユーザが気付ける)。
	// 新規作成のフォームで保存すれば重複エントリになるので、その事実は切り替え後の
	// 案内で知らせ、一括レビュー側の「既存に目撃記録を足す」へ戻れるようにしておく。
	return candidates[0] ?? null;
}

/**
 * エントリ1件に添付できる枚数まで写真を切り詰める。
 *
 * 一括解析は最大10枚を受け付けるが、銘柄1件に保存できるのは6枚まで。単一ワイン判定の
 * 引き継ぎと「手動で入力」の引き継ぎが同じ切り詰め方をするよう、ここに寄せる。
 */
export function takePhotosForEntry(files: File[]): {
	files: File[];
	droppedPhotoCount: number;
} {
	return {
		files: files.slice(0, MAX_HANDOFF_PHOTOS),
		droppedPhotoCount: Math.max(0, files.length - MAX_HANDOFF_PHOTOS),
	};
}

/**
 * 候補と選択中の写真から荷物を組み立てる。
 *
 * 価格は**銘柄の price 欄**へ入れる。一括登録では「その店での売値」として目撃記録
 * 側へ入れているが、単一ワインのエチケット写真に店の売値という文脈は無く、読み取れた
 * 価格はそのワインの値段とみなすのが自然なため(#416 の決定)。
 *
 * ステータスは引き継がない。一括登録の既定は「見かけた」だが、1本のエチケットを
 * わざわざ撮る人は飲んだ/持っている場合が多いので、フォームの既定に委ねる。
 */
export function buildSingleWineHandoff(
	candidate: WineListCandidate,
	files: File[],
	discardedSightingInput = false,
	// 解析を経た経路なので values は必ず入る(呼び出し側で undefined を考えずに済む)
): ManualFormStart & { values: DrunkWineFieldsValue } {
	return {
		values: valuesFromSuggestions(
			candidate.suggestions,
			DEFAULT_WINE_STATUS,
			candidate.price,
		),
		...takePhotosForEntry(files),
		reason: "single_wine",
		discardedSightingInput,
	};
}
