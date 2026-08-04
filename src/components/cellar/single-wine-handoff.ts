import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import { valuesFromSuggestions } from "#/components/cellar/import-candidates";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import { DEFAULT_WINE_STATUS } from "#/lib/drunk-wine/status";
import type { WineListAnalysisSummary } from "#/lib/services/ai-service";

// 写真からの一括登録(/cellar/import)で「写っているのは1本のワインのエチケット
// だった」と分かったときに、単体の「ワインを記録」(/cellar/new)へ渡す荷物と、
// その判定(Issue #416)。
//
// 判定は **AIの被写体判定(subject) と 抽出銘柄が1件であること の両方**を要求する。
// subject だけだと「1本のつもりで撮った棚の写真」から他の銘柄が黙って落ち、件数だけ
// だと「1銘柄しか読めなかったワインリスト」まで単体登録へ飛ばしてしまう。
//
// 受け渡しに router の location.state を使わないのは、荷物に File(写真の実体)が
// 含まれるため。history.state はページ再読み込みで復元されるので、File が復元
// できない/巨大なまま履歴に載る形は避け、**同一タブ内の1回限りの受け渡し**に
// 割り切ったモジュールスコープの箱で渡す(取り出したら消える)。

/** 引き継げる写真の枚数。エントリ1件の上限(6枚)で、一括登録の上限(10枚)より小さい。 */
export const MAX_HANDOFF_PHOTOS = MAX_PHOTOS_PER_ENTRY;

/** 「ワインを記録」へ渡す荷物。 */
export interface SingleWineHandoff {
	/** フォームの初期値(一括解析で読み取った内容)。 */
	values: DrunkWineFieldsValue;
	/** フォームに添付済みにする写真(先頭 MAX_HANDOFF_PHOTOS 枚)。 */
	files: File[];
	/** 引き継げず落とした写真の枚数。0 なら全部引き継げている。 */
	droppedPhotoCount: number;
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
	// 既存セラーに同じ銘柄がある場合も候補にはする(遷移するかはユーザが選ぶ)。
	// 新規作成のフォームへ飛べば重複エントリになるので、その事実は確認ダイアログ
	// (candidate.existing)で知らせ、一括レビュー側の「既存に目撃記録を足す」を
	// 選べるようにしておく。
	return candidates[0] ?? null;
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
): SingleWineHandoff {
	return {
		values: valuesFromSuggestions(
			candidate.suggestions,
			DEFAULT_WINE_STATUS,
			candidate.price,
		),
		files: files.slice(0, MAX_HANDOFF_PHOTOS),
		droppedPhotoCount: Math.max(0, files.length - MAX_HANDOFF_PHOTOS),
	};
}

// 遷移をまたいで荷物を渡す箱。/cellar/import が置き、/cellar/new が取り出す。
let pending: SingleWineHandoff | null = null;

/** 荷物を預ける(遷移の直前に呼ぶ)。 */
export function setSingleWineHandoff(handoff: SingleWineHandoff): void {
	pending = handoff;
}

/**
 * 荷物を取り出す(1回限り。無ければ null)。
 *
 * 取り出したら消すのは、「ワインを記録」を保存後にもう一度開いたときに前回の
 * 写真と銘柄が蘇らないようにするため。
 */
export function takeSingleWineHandoff(): SingleWineHandoff | null {
	const handoff = pending;
	pending = null;
	return handoff;
}
