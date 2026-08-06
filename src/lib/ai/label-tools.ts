import { jsonSchema, tool } from "ai";
import { z } from "zod";
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

/** `submit_answer` が受け付ける最終回答の形。抽出フィールドの SSOT から derive する。 */
export const SUBMIT_ANSWER_SCHEMA = jsonSchema<Record<string, unknown>>(
	LABEL_WEB_JSON_SCHEMA as unknown as Record<string, unknown>,
);

/** 提出された回答と、その検証結果。 */
export interface SubmittedAnswer {
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
export type VerifyContextProvider = () => LabelVerifyContext;

/**
 * エージェントループに渡すツール一式を組み立てる。
 *
 * @param collector 提出された回答の受け取り先(呼び出し側がループ後に読む)
 * @param getVerifyContext 検証に使う文脈を返す関数。web検索の軌跡は毎ターン伸びるので、
 *   組み立て時点の値を焼き込まず提出のたびに最新を取る
 */
export function buildLabelTools(
	collector: AnswerCollector,
	getVerifyContext: VerifyContextProvider,
) {
	return {
		search_appellation: tool({
			description:
				"原産地呼称(AOC/AOP/DOC/DOCG等)をこのアプリのマスタから検索する。綴りが不確かなときに候補を引く。該当があればその正式表記をそのまま使うこと。マスタは対応地域ぶんしか無いので、見つからなくても誤りとは限らない。",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("呼称名の一部または全体(原語・日本語のどちらでもよい)"),
			}),
			execute: ({ query }) => {
				const hits = searchAppellations(query, APPELLATION_SEARCH_LIMIT);
				return { hits, count: hits.length };
			},
		}),

		get_appellation: tool({
			description:
				"呼称の詳細(許可品種・主要生産者・格付け・地域)を引く。読み取った品種がその呼称で認められているかの確認に使う。idは search_appellation か lookup_producer が返したものを渡すこと。",
			inputSchema: z.object({
				id: z.string().min(1).describe("呼称のid(例: chablis-grand-cru)"),
			}),
			execute: ({ id }) => {
				const detail = getAppellationDetail(id);
				return detail ?? { error: `呼称 ${id} はマスタにありません` };
			},
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
			execute: ({ name }) => {
				const hits = lookupProducer(name);
				return { hits, count: hits.length };
			},
		}),

		[SUBMIT_ANSWER_TOOL_NAME]: tool({
			description:
				"特定した情報を最終回答として提出する。提出された内容は検証され、問題があれば指摘が返る。指摘が返ったら調べ直して再度呼ぶこと。問題が無ければこれで完了。",
			inputSchema: SUBMIT_ANSWER_SCHEMA,
			execute: (answer) => {
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
		}),
	};
}
