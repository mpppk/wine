// 写真ウィザードの「写真を解析する」を押せるかの判定。
//
// **押せる条件をボタンのJSXに散らばらせない**。解析はAIクレジットを消費するので、
// 「押せてしまう窓」がそのまま二重消費になる。実際に2つの窓が同時に空いていた:
//
//  1. 投入が返ってから最初のポーリングが返るまで、ジョブの状態が `undefined` で
//     「解析中」と判定できず、ボタンが有効に戻っていた(記録フォーム側で #490 が
//     塞いだのと同じ穴)
//  2. 解析結果の画面から「写真の選択に戻る」と結果を捨てていたため、**同じ写真で
//     もう一度解析**でき、同じ結果にクレジットをもう一度払えた
//
// 呼び出し側は状態を渡すだけにして、優先順位(=利用者に見せる理由)もここで決める。

/**
 * 選択中の写真を一意に表す印。**順序も含めて**同じなら同じ解析になる
 * (候補の `photoIndexes` が並び順を指すため、並べ替えは別の解析として扱う)。
 */
export function photoSetKey(localIds: readonly string[]): string {
	return localIds.join("\n");
}

/** 解析ボタンを押せない理由。null なら押せる。 */
export type AnalyzeBlockReason =
	| "analyzing"
	| "loading_photos"
	| "no_photos"
	| "already_analyzed"
	| "insufficient_credits"
	| "missing_place_name";

export interface AnalyzeGateInput {
	/** 選択中の写真の印(`photoSetKey`)。 */
	photoKey: string;
	/** 解析済みの写真の印。null = この写真でまだ解析していない。 */
	analyzedPhotoKey: string | null;
	/** 選択中の写真の枚数。 */
	photoCount: number;
	/** 投入中、または投入済みで結果待ち。 */
	analyzing: boolean;
	/** 再解析の元バッチから保存済み写真を読み込んでいる最中か。 */
	loadingPhotos: boolean;
	/** クレジット残高が足りない(残高が分かっているときだけ true)。 */
	insufficientCredits: boolean;
	/** 「新しい場所を追加」を選んだのに名前が空。 */
	missingPlaceName: boolean;
}

/**
 * 解析を始められるか。始められないなら**最初に当たった理由**を返す。
 *
 * 順序は「利用者が次に何をすればいいか」が変わる順。進行中(`analyzing` /
 * `loading_photos`)は待てば解けるので先に、写真の不足はその次、`already_analyzed` は
 * 残高や入力より先に出す——残高が足りない回でも、既に結果があるなら見に行けばよく、
 * 「クレジットが足りません」を先に出すと払えば解けるように読める。
 */
export function analyzeBlockReason(
	input: AnalyzeGateInput,
): AnalyzeBlockReason | null {
	if (input.analyzing) return "analyzing";
	if (input.loadingPhotos) return "loading_photos";
	if (input.photoCount === 0) return "no_photos";
	if (
		input.analyzedPhotoKey !== null &&
		input.analyzedPhotoKey === input.photoKey
	) {
		return "already_analyzed";
	}
	if (input.insufficientCredits) return "insufficient_credits";
	if (input.missingPlaceName) return "missing_place_name";
	return null;
}
