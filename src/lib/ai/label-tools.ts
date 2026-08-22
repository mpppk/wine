import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { NormalizedBox } from "#/lib/images/crop-geometry";
import {
	LABEL_WEB_JSON_SCHEMA,
	type LabelExtraction,
	type LabelFieldSources,
	parseLabelResponse,
	parseLabelSources,
} from "./label-extraction";
import {
	APPELLATION_SEARCH_LIMIT,
	getAppellationDetail,
	lookupProducer,
	searchAppellations,
} from "./label-tool-logic";
import { type LabelVerifyContext, verifyLabelAnswer } from "./label-verify";

// エージェントループがモデルへ渡すツールの定義。中身は label-tool-logic.ts(純ロジック)、
// 検証は label-verify.ts に分けてあり、ここは**AI SDK の形に載せる薄い層**。
//
// `submit_answer` だけ性質が違う: これは**ループの終端**であり、`execute` の中で検証器を
// 走らせる。合格ならループを止め、不合格なら**問題点をツール結果としてモデルに返す**ので、
// 追加の制御構造なしに「指摘 → 調べ直し → 再提出」が回る。停止条件・検証・フィードバックが
// 1箇所に集まるのがこの形の利点。

/** ツール名。計上・軌跡・stopWhen が同じ名前を見るので定数で持つ。 */
export const SUBMIT_ANSWER_TOOL_NAME = "submit_answer";

/** 写真の一部を拡大して読み直すツールの名前。 */
export const ZOOM_PHOTO_TOOL_NAME = "zoom_photo";

/**
 * 拡大結果の長辺の上限。**元より大きくはしない**(resolveOutputWidth)。
 * 大きすぎると入力トークンが嵩み、小さすぎると拡大した意味が消える。
 */
export const ZOOM_OUTPUT_MAX_DIMENSION = 1024;

/**
 * 写真の一部を切り出してモデルへ返すツール。
 *
 * **エチケット解析の精度を決めるのはここ**。ボトル全体が写った写真では、原寸(2180px)を
 * 送っても生産者名を読めない —— プロバイダが画像を内部で縮小するため、画角に占める
 * 割合が小さい文字は潰れる。実測では、同じ写真でも**ラベル部分を切り出した途端に
 * 正解へ到達した**(全体写真では9回連続で誤答)。
 *
 * 結果は `toModelOutput` で**画像として**返す。JSONで座標だけ返しても読めるようには
 * ならないので、切り出した画素そのものを会話に載せる必要がある。
 */
function buildZoomTool(photoCount: number, cropPhoto: CropPhoto) {
	return tool({
		description: [
			"写真の一部を拡大して読み直す。**文字が小さくて読めないときに使う**。",
			"ラベルの文字はボトル全体の写真では潰れて読めないことが多いので、",
			"生産者名・ワイン名・ヴィンテージが読み取れないときは推測せずこれを使うこと。",
			"座標は画像の左上を (0,0)、右下を (1,1) とする正規化値。",
			"読みたい文字が確実に入るよう余裕をもった範囲を指定する(狭すぎる指定は自動で広がる)。",
			"結果には実際に適用した範囲が付くので、ずれていたら指定し直せる。",
		].join("\n"),
		inputSchema: z.object({
			photoIndex: z
				.number()
				.int()
				.min(0)
				.describe("拡大する写真の番号(0始まり)"),
			x: z.number().describe("左端の位置(0〜1)"),
			y: z.number().describe("上端の位置(0〜1)"),
			width: z.number().describe("幅(0〜1)"),
			height: z.number().describe("高さ(0〜1)"),
		}),
		execute: async ({ photoIndex, x, y, width, height }) => {
			if (photoIndex < 0 || photoIndex >= photoCount) {
				return {
					error: `写真 ${photoIndex} はありません(0〜${photoCount - 1} の範囲で指定してください)`,
				};
			}
			const cropped = await cropPhoto(photoIndex, { x, y, width, height });
			return {
				photoIndex,
				applied: cropped.applied,
				dataUrl: cropped.dataUrl,
			};
		},
		// 画像はJSONではなくメディアとして会話へ載せる(座標だけ返しても読めない)。
		// data URI から base64 部分だけを取り出して渡す。
		toModelOutput: (options: { output: unknown }) => {
			const result = options.output as {
				error?: string;
				applied?: NormalizedBox;
				dataUrl?: string;
			};
			if (result.error || !result.dataUrl) {
				return {
					type: "error-text",
					value: result.error ?? "拡大に失敗しました",
				};
			}
			const comma = result.dataUrl.indexOf(",");
			return {
				type: "content",
				value: [
					{
						type: "text",
						text: `適用した範囲: ${JSON.stringify(result.applied)}`,
					},
					{
						type: "file",
						mediaType: "image/jpeg",
						// FileData はタグ付き共用体。base64 文字列は type: "data" で渡す。
						data: { type: "data", data: result.dataUrl.slice(comma + 1) },
					},
				],
			};
		},
	});
}

/** `submit_answer` が受け付ける最終回答の形。抽出フィールドの SSOT から derive する。 */
export const SUBMIT_ANSWER_SCHEMA = jsonSchema<Record<string, unknown>>(
	LABEL_WEB_JSON_SCHEMA as unknown as Record<string, unknown>,
);

/** 提出された回答と、その検証結果。 */
interface SubmittedAnswer {
	extraction: LabelExtraction;
	fieldSources?: LabelFieldSources;
	/** 検証を通ったか。通らなかった回答も「最後の手段」として保持する。 */
	verified: boolean;
}

/**
 * 提出を受け取る側の状態。**ループの外で読む**ので呼び出し側が持つ。
 *
 * 検証を通らなかった回答も `last` に残すのは可用性のため: ステップ上限や予算で
 * 打ち切られたとき、「不完全でも候補を返す」ほうが「解析失敗」より利用者の得になる
 * (フォームの自動入力候補であって、確定値ではない)。
 */
export interface AnswerCollector {
	/** 検証を通った回答。あればこれを採用する。 */
	accepted?: SubmittedAnswer;
	/** 最後に提出された回答(検証の可否を問わない)。 */
	last?: SubmittedAnswer;
}

/** 検証の文脈(軌跡)は毎ターン更新されるので、参照時に取りに行く。 */
type VerifyContextProvider = () => LabelVerifyContext;

/**
 * 写真の一部を切り出す関数。**env 依存を注入する**(`env.IMAGES` を使うので、
 * ここで直接呼ぶと純ロジックのテストから触れなくなる)。
 */
export type CropPhoto = (
	photoIndex: number,
	box: NormalizedBox,
) => Promise<{ dataUrl: string; applied: NormalizedBox }>;

export interface LabelToolsOptions {
	/** 提出された回答の受け取り先(呼び出し側がループ後に読む)。 */
	collector: AnswerCollector;
	/**
	 * 検証に使う文脈を返す関数。web検索の軌跡は毎ターン伸びるので、組み立て時点の値を
	 * 焼き込まず提出のたびに最新を取る。
	 */
	getVerifyContext: VerifyContextProvider;
	/** 解析対象の写真の枚数(`zoom_photo` の添字の範囲チェックに使う)。 */
	photoCount: number;
	/** 写真の一部を切り出す。省略すると `zoom_photo` を出さない。 */
	cropPhoto?: CropPhoto;
	/**
	 * ツール実行の観測口(#514)。execute が正常に終わったら `result`、
	 * throw したら `error` を載せて呼ぶ。**結果はここでサニタイズする**: `zoom_photo`
	 * の結果には切り出し画像の data URI が乗るので、範囲(`applied`)だけを残して落とす。
	 * 省略時は何も報告しない。
	 */
	observe?: (event: {
		tool: string;
		input: unknown;
		result?: unknown;
		error?: string;
	}) => void;
}

/** execute を観測つきへ包む。失敗は観測してから再 throw する(挙動は変えない)。 */
function withObservation<A, R>(
	toolName: string,
	execute: (input: A) => R,
	observe: LabelToolsOptions["observe"],
): (input: A) => R | Promise<R> {
	if (!observe) return execute;
	return async (input: A): Promise<R> => {
		try {
			const result = await execute(input);
			observe({ tool: toolName, input, result });
			return result;
		} catch (e) {
			observe({
				tool: toolName,
				input,
				error: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
	};
}

/**
 * `cropPhoto` を観測つきへ包む。**切り出し画像そのものは載せない**——結果には
 * 範囲(`applied`)だけを残す(#514 の写真方針)。切り出しの入出力は引数が
 * オブジェクト1つの他ツールと形が違うため、専用の包みにする。
 */
function observeCropPhoto(
	cropPhoto: CropPhoto,
	observe: LabelToolsOptions["observe"],
): CropPhoto {
	if (!observe) return cropPhoto;
	return async (photoIndex, box) => {
		const input = { photoIndex, ...box };
		try {
			const cropped = await cropPhoto(photoIndex, box);
			observe({
				tool: ZOOM_PHOTO_TOOL_NAME,
				input,
				result: { applied: cropped.applied },
			});
			return cropped;
		} catch (e) {
			observe({
				tool: ZOOM_PHOTO_TOOL_NAME,
				input,
				error: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
	};
}

/**
 * エージェントループに渡すツール一式を組み立てる。
 */
export function buildLabelTools({
	collector,
	getVerifyContext,
	photoCount,
	cropPhoto,
	observe,
}: LabelToolsOptions) {
	return {
		...(cropPhoto
			? {
					[ZOOM_PHOTO_TOOL_NAME]: buildZoomTool(
						photoCount,
						observeCropPhoto(cropPhoto, observe),
					),
				}
			: {}),
		search_appellation: tool({
			description:
				"原産地呼称(AOC/AOP/DOC/DOCG等)をこのアプリのマスタから検索する。綴りが不確かなときに候補を引く。該当があればその正式表記をそのまま使うこと。マスタは対応地域ぶんしか無いので、見つからなくても誤りとは限らない。",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("呼称名の一部または全体(原語・日本語のどちらでもよい)"),
			}),
			execute: withObservation(
				"search_appellation",
				({ query }) => {
					const hits = searchAppellations(query, APPELLATION_SEARCH_LIMIT);
					return { hits, count: hits.length };
				},
				observe,
			),
		}),

		get_appellation: tool({
			description:
				"呼称の詳細(許可品種・主要生産者・格付け・地域)を引く。読み取った品種がその呼称で認められているかの確認に使う。idは search_appellation か lookup_producer が返したものを渡すこと。",
			inputSchema: z.object({
				id: z.string().min(1).describe("呼称のid(例: chablis-grand-cru)"),
			}),
			execute: withObservation(
				"get_appellation",
				({ id }) => {
					const detail = getAppellationDetail(id);
					return detail ?? { error: `呼称 ${id} はマスタにありません` };
				},
				observe,
			),
		}),

		lookup_producer: tool({
			description:
				"生産者名から、その生産者が登録されている呼称を逆引きする。ラベルの呼称が欠けている・読めないときの手がかりになる。公式サイトが分かる場合はそれも返すので、web検索の参照先に使える。",
			inputSchema: z.object({
				name: z
					.string()
					.min(1)
					.describe("生産者名の一部または全体(例: Recougne)"),
			}),
			execute: withObservation(
				"lookup_producer",
				({ name }) => {
					const hits = lookupProducer(name);
					return { hits, count: hits.length };
				},
				observe,
			),
		}),

		[SUBMIT_ANSWER_TOOL_NAME]: tool({
			description:
				"特定した情報を最終回答として提出する。提出された内容は検証され、問題があれば指摘が返る。指摘が返ったら調べ直して再度呼ぶこと。問題が無ければこれで完了。",
			inputSchema: SUBMIT_ANSWER_SCHEMA,
			execute: withObservation(
				SUBMIT_ANSWER_TOOL_NAME,
				(answer) => {
					// パースは他経路と共通の関門を通す(型の揺れの吸収も含めて挙動を揃える)。
					const extraction = parseLabelResponse(answer);
					const fieldSources = parseLabelSources(answer);
					const context = getVerifyContext();
					const result = verifyLabelAnswer(extraction, {
						...context,
						fieldSources,
					});
					const submitted: SubmittedAnswer = {
						extraction,
						...(fieldSources ? { fieldSources } : {}),
						verified: result.ok,
					};
					collector.last = submitted;
					if (result.ok) {
						collector.accepted = submitted;
						return { accepted: true as const };
					}
					return {
						accepted: false as const,
						problems: result.problems,
						hint: "指摘された点を調べ直して、修正した内容で再度 submit_answer を呼んでください。確認できない項目は null / 空配列にして構いません。",
					};
				},
				observe,
			),
		}),
	};
}
