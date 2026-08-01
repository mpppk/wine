import type { ExpressionSpecification } from "maplibre-gl";
import { PROGRESS_EMPTY_COLOR } from "#/lib/wine/map-style";
import { WINE_STATUS_IDS, type WineStatus } from "./status";

// マイセラー地図(/cellar/map)の所有状態モードの配色。AOPの区分・進捗の配色は
// 静的ドメインの src/lib/wine/map-style.ts にあるが、所有状態は drunk-wine の
// 概念なのでこちらに置く(wine → drunk-wine の逆依存を作らない)。
//
// 4状態のカテゴリカル配色。区分モードの赤系(KIND_COLORS)・進捗モードの緑系
// (PROGRESS_BUCKETS)のどちらとも混同しない色相を選ぶ。dataviz skill の
// validate_palette を categorical・`--pairs all`(地図なので隣接ペアでは足りない)・
// surface #f2f0ec で実行し、fill・line とも5チェック全PASSを確認済み
// (明度帯・彩度下限・CVD分離・通常視の下限・サーフェスとのコントラスト)。
// 色を変えるときは必ず同じコマンドを通し直すこと。
//
// **4色目(spotted)の追加で line 側を総取り替えした理由**(Issue #358)。
// all-pairs は3色でもかなり厳しく(dataviz skill の既定パレットも「all-pairs では
// 先頭3スロットまで」と明記している)、4色目を足すと組み合わせが3ペアから6ペアに
// 増えて一気に飽和する。fill は既存3色を保ったまま紫(#6940b0)が入る余地があったが、
// line は旧3色(#1c5cab / #8f5b00 / #7f325e)が既に明度帯の下限付近に固まっていて、
// そこへ「fill より暗い紫」を入れる余地が OKLCH 全域を探しても無かった。
// fill(=面)を据え置き line(=輪郭線)だけ再ステップするのは、見た目の変化が最も
// 小さい形で全チェックを通せる唯一の解だったため。
export const STATUS_COLORS: Record<WineStatus, { fill: string; line: string }> =
	{
		// 「今すぐ飲める1本がある」= 次の行動に最も近いので、最も目を引く青を当てる
		owned: { fill: "#2a78d6", line: "#036cd4" },
		wishlist: { fill: "#c07a00", line: "#81520a" },
		finished: { fill: "#a8447e", line: "#930165" },
		// 「店で見かけただけ」。既存3色・赤系・緑系のいずれとも色相が離れた紫を当てる
		spotted: { fill: "#6940b0", line: "#6600c3" },
	};

/**
 * マイセラーに1本も無いAOPの色。進捗モードの「データなし」と同じ中立グレーを使い、
 * 「値が無い」の見え方をモード間で揃える。
 */
export const STATUS_EMPTY_COLOR = PROGRESS_EMPTY_COLOR;

// feature-state.status(文字列)を match で色に写す。progress が数値→step なのに対し
// status は文字列なので、数値コードへ変換して step を流用するより match が直接的で、
// WineStatus の union とそのまま対応する。未設定は coalesce で "" に落ち、
// どの状態にも一致しないので既定(empty)色になる。
function buildStatusMatchExpr(
	pick: (c: { fill: string; line: string }) => string,
	empty: string,
): ExpressionSpecification {
	const args: string[] = [];
	// WINE_STATUS_IDS を回すことで、状態を足したのに色を足し忘れたら
	// 型エラー(STATUS_COLORS の Record)で気付ける。
	for (const id of WINE_STATUS_IDS) {
		args.push(id, pick(STATUS_COLORS[id]));
	}
	return [
		"match",
		["coalesce", ["feature-state", "status"], ""],
		...args,
		empty,
	] as unknown as ExpressionSpecification;
}

export function statusFillColorExpr(): ExpressionSpecification {
	return buildStatusMatchExpr((c) => c.fill, STATUS_EMPTY_COLOR.fill);
}

export function statusLineColorExpr(): ExpressionSpecification {
	return buildStatusMatchExpr((c) => c.line, STATUS_EMPTY_COLOR.line);
}
