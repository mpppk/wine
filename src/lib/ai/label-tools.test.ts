import { describe, expect, it } from "vitest";
import type { NormalizedBox } from "#/lib/images/crop-geometry";
import { LABEL_WEB_JSON_SCHEMA } from "./label-extraction";
import {
	type AnswerCollector,
	buildLabelTools,
	SUBMIT_ANSWER_SCHEMA,
	SUBMIT_ANSWER_TOOL_NAME,
	ZOOM_PHOTO_TOOL_NAME,
} from "./label-tools";
import type { WebResearchTrace } from "./web-research-trace";

// `submit_answer` は**ループの終端**。execute の中で検証器を走らせ、合格なら
// collector に積んで停止条件を満たし、不合格なら問題点をツール結果として返すので、
// 追加の制御構造なしに「指摘 → 調べ直し → 再提出」が回る。

const trace: WebResearchTrace = {
	steps: [{ action: "search", query: "q", urls: ["https://www.vivino.com/x"] }],
	stepCount: 1,
	hosts: ["www.vivino.com"],
};

/** ツールの execute を型を気にせず呼ぶための薄いヘルパ(SDKの引数は使っていない)。 */
async function callSubmit(
	collector: AnswerCollector,
	answer: Record<string, unknown>,
	context: { trace?: WebResearchTrace } = {},
) {
	const tools = buildLabelTools({
		collector,
		getVerifyContext: () => context,
		photoCount: 1,
	});
	const submit = tools[SUBMIT_ANSWER_TOOL_NAME] as unknown as {
		execute: (input: unknown) => unknown;
	};
	return await submit.execute(answer);
}

const validAnswer = {
	wine_name: "Chablis Les Clos",
	producer: "Vincent Dauvissat",
	vintage: 2020,
	appellation: "Chablis Grand Cru",
	region: "Bourgogne",
	country: "France",
	grape_varieties: ["Chardonnay"],
};

describe("buildLabelTools", () => {
	it("マスタ参照3種と提出ツールを渡す", () => {
		const tools = buildLabelTools({
			collector: {},
			getVerifyContext: () => ({}),
			photoCount: 1,
		});
		expect(Object.keys(tools).sort()).toEqual([
			"get_appellation",
			"lookup_producer",
			"search_appellation",
			SUBMIT_ANSWER_TOOL_NAME,
		]);
	});

	it("提出ツールの入力形式は抽出フィールドの SSOT から derive する", () => {
		expect(SUBMIT_ANSWER_SCHEMA.jsonSchema).toBe(LABEL_WEB_JSON_SCHEMA);
	});
});

describe("submit_answer", () => {
	it("検証を通った回答は accepted に入る(= ループの停止条件を満たす)", async () => {
		const collector: AnswerCollector = {};
		const result = await callSubmit(collector, validAnswer);
		expect(result).toEqual({ accepted: true });
		expect(collector.accepted?.verified).toBe(true);
		expect(collector.accepted?.extraction).toMatchObject({
			wineName: "Chablis Les Clos",
			vintage: 2020,
		});
	});

	it("検証を通らない回答は accepted に入らず、問題点を返す", async () => {
		const collector: AnswerCollector = {};
		const result = (await callSubmit(collector, {
			...validAnswer,
			grape_varieties: ["Merlot"],
		})) as { accepted: boolean; problems?: { field: string }[] };
		expect(result.accepted).toBe(false);
		expect(result.problems?.[0]?.field).toBe("grape_varieties");
		expect(collector.accepted).toBeUndefined();
	});

	it("不合格の回答も last には残す(打ち切り時の最後の手段)", async () => {
		// 予算・ステップ上限で打ち切られたとき、「不完全でも候補を返す」ほうが
		// 「解析失敗」より利用者の得になる(フォームの自動入力候補であって確定値ではない)。
		const collector: AnswerCollector = {};
		await callSubmit(collector, {
			...validAnswer,
			grape_varieties: ["Merlot"],
		});
		expect(collector.last?.verified).toBe(false);
		expect(collector.last?.extraction.producer).toBe("Vincent Dauvissat");
	});

	it("再提出で合格したら accepted が入り、last も更新される", async () => {
		const collector: AnswerCollector = {};
		await callSubmit(collector, {
			...validAnswer,
			grape_varieties: ["Merlot"],
		});
		expect(collector.accepted).toBeUndefined();
		await callSubmit(collector, validAnswer);
		expect(collector.accepted?.verified).toBe(true);
		expect(collector.last?.verified).toBe(true);
	});

	it("軌跡は提出のたびに最新を取りに行く(組み立て時の値を焼き込まない)", async () => {
		// web検索は提出より後のターンでも走る。組み立て時点の軌跡を焼き込むと、
		// 「後から開いたページ」の引用をURLの創作とみなして落としてしまう。
		const collector: AnswerCollector = {};
		let current: { trace?: WebResearchTrace } = {};
		const tools = buildLabelTools({
			collector,
			getVerifyContext: () => current,
			photoCount: 1,
		});
		const submit = tools[SUBMIT_ANSWER_TOOL_NAME] as unknown as {
			execute: (input: unknown) => unknown;
		};
		const withCitation = {
			...validAnswer,
			sources: {
				producer: { origin: "web", url: "https://www.vivino.com/dauvissat" },
			},
		};
		// 軌跡が空のうちは「検索していないのに web を名乗る」で落ちる
		const before = (await submit.execute(withCitation)) as {
			accepted: boolean;
		};
		expect(before.accepted).toBe(false);
		// 検索が走った後は同じ回答が通る
		current = { trace };
		const after = (await submit.execute(withCitation)) as { accepted: boolean };
		expect(after.accepted).toBe(true);
	});

	it("根拠つきの回答は origin と参照URLを保持する", async () => {
		const collector: AnswerCollector = {};
		await callSubmit(
			collector,
			{
				...validAnswer,
				sources: {
					producer: {
						origin: "photo_and_web",
						url: "https://www.vivino.com/d",
					},
				},
			},
			{ trace },
		);
		expect(collector.accepted?.fieldSources?.producer).toEqual({
			origin: "photo_and_web",
			url: "https://www.vivino.com/d",
		});
	});
});

describe("zoom_photo", () => {
	// **この経路の精度を決めるツール**。ボトル全体の写真ではラベルの文字が潰れて読めず、
	// 実測では原寸(2180px)を送っても改善しなかった。効いたのは切り出しだけ。
	const crop = async (_photoIndex: number, box: NormalizedBox) => ({
		dataUrl: "data:image/jpeg;base64,QUJD",
		applied: { ...box, x: box.x + 0.01 },
	});

	function zoomTool(photoCount: number, cropPhoto = crop) {
		const tools = buildLabelTools({
			collector: {},
			getVerifyContext: () => ({}),
			photoCount,
			cropPhoto,
		});
		return tools[ZOOM_PHOTO_TOOL_NAME] as unknown as {
			execute: (input: unknown) => unknown;
			toModelOutput: (options: { output: unknown }) => unknown;
		};
	}

	it("cropPhoto を渡さなければツールを出さない", () => {
		// 変換手段が無い環境で「使えないツール」を見せない
		const tools = buildLabelTools({
			collector: {},
			getVerifyContext: () => ({}),
			photoCount: 1,
		});
		expect(ZOOM_PHOTO_TOOL_NAME in tools).toBe(false);
	});

	it("範囲外の写真番号はエラーを返す(throw しない)", async () => {
		const result = (await zoomTool(2).execute({
			photoIndex: 5,
			x: 0,
			y: 0,
			width: 1,
			height: 1,
		})) as { error?: string };
		expect(result.error).toContain("写真 5 はありません");
	});

	it("結果は画像としてモデルへ返す(座標だけ返しても読めるようにならない)", async () => {
		const tool = zoomTool(1);
		const output = await tool.execute({
			photoIndex: 0,
			x: 0.3,
			y: 0.4,
			width: 0.2,
			height: 0.2,
		});
		const modelOutput = tool.toModelOutput({ output }) as {
			type: string;
			value: { type: string; mediaType?: string }[];
		};
		expect(modelOutput.type).toBe("content");
		expect(modelOutput.value.map((v) => v.type)).toEqual(["text", "file"]);
		expect(modelOutput.value[1]?.mediaType).toBe("image/jpeg");
	});

	it("適用した範囲を本文で伝える(モデルがズレに気づける)", async () => {
		const tool = zoomTool(1);
		const output = await tool.execute({
			photoIndex: 0,
			x: 0.3,
			y: 0.4,
			width: 0.2,
			height: 0.2,
		});
		const modelOutput = tool.toModelOutput({ output }) as {
			value: { type: string; text?: string }[];
		};
		// 指定(0.3)ではなく実際に適用された値(0.31)が載る
		expect(modelOutput.value[0]?.text).toContain("0.31");
	});

	it("失敗はエラーとしてモデルへ返す", () => {
		const modelOutput = zoomTool(1).toModelOutput({
			output: { error: "写真 5 はありません" },
		}) as { type: string; value: string };
		expect(modelOutput.type).toBe("error-text");
		expect(modelOutput.value).toContain("写真 5 はありません");
	});
});
