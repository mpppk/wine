// 高精度エチケット解析(LLM + web検索)の**検索の軌跡**を、プロバイダ非依存の形へ
// 畳むための純ロジック。
//
// この経路の精度は「web検索で裏を取る」ことから来ているのに、そこで何を検索し何を
// 読んだかは応答の外からは一切見えなかった。結果として推定がおかしかったときに、
// 「読み取りを間違えた」のか「検索で拾った情報が間違っていた」のかを切り分ける手段が
// 無い(検索結果は毎回変わるので、後から同じ写真で再実行しても再現しない)。実行時に
// 拾って実行記録へ載せる以外に観測手段が無いため、ここで軌跡を組み立てる。
//
// 抽出は経路ごとに形が全く違う(Claude SDK は content ブロックの server_tool_use /
// web_search_tool_result のペア、AI SDK はツール結果の output)ので、それぞれの抽出器を
// 用意して**同じ型**に落とす。ログの読み手が経路ごとに別のフィールドを覚えなくて
// 済むようにするため。
//
// SDK の型には合わせにいかず unknown で受けて絞り込む: どちらの SDK も判別共用体が
// バージョンごとに増え、テスト用のダミー値が組み立てられなくなる(label-gpt-research.ts の
// findRefusal と同じ理由)。ここで拾えなかったブロックは黙って無視され、ログが少し
// 痩せるだけで解析そのものは壊れない、という失敗の仕方に倒す。

/** 1操作ぶんの軌跡。 */
export interface WebResearchStep {
	/** 操作の種類。search=検索、open=ページを開いた、find=ページ内検索。 */
	action: "search" | "open" | "find";
	/** 検索語(search)/ページ内の検索パターン(find)。open では持たない。 */
	query?: string;
	/** 参照したURL。search は結果、open/find は対象ページ。 */
	urls?: string[];
	/** この操作が返したURLの総数。`urls` を上限で切っても総量が分かるよう別に持つ。 */
	urlCount?: number;
	/** 失敗したときのエラーコード(max_uses_exceeded / too_many_requests など)。 */
	error?: string;
}

/** 1回の解析ぶんの検索の軌跡。実行記録の1フィールドとして載せる。 */
export interface WebResearchTrace {
	/** 実行順の操作列。上限で打ち切る(打ち切りの有無は stepCount との差で分かる)。 */
	steps: WebResearchStep[];
	/** 実行された操作の総数。`steps` を切っても総量が分かるよう別に持つ。 */
	stepCount: number;
	/**
	 * 参照した一意なホスト名。**「どのサイトを見たか」はこれ1つで足りる**ことが多く、
	 * `--grep vivino` のような雑な検索でも引っかかるようにするための要約。
	 */
	hosts: string[];
}

/**
 * 1行に載せる操作数の上限。Claude は `max_uses`(=8)で縛れるが、GPT経路は検索回数を
 * 直接縛れず `open_page` / `find_in_page` も1アイテムずつ積まれるので、ログ行の肥大化は
 * ここで止める。
 */
export const WEB_RESEARCH_MAX_STEPS = 20;

/** 1操作あたりに載せるURLの数。検索は10件前後返るが、全件を残すと1行が肥大化する。 */
export const WEB_RESEARCH_MAX_URLS_PER_STEP = 5;

/** `hosts` に載せる一意ホストの上限。 */
export const WEB_RESEARCH_MAX_HOSTS = 30;

/** 収集した操作列を、上限を適用した `WebResearchTrace` に畳む。 */
function toTrace(steps: WebResearchStep[]): WebResearchTrace {
	const hosts: string[] = [];
	for (const step of steps) {
		for (const url of step.urls ?? []) {
			const host = toHost(url);
			if (!host || hosts.includes(host)) continue;
			if (hosts.length >= WEB_RESEARCH_MAX_HOSTS) break;
			hosts.push(host);
		}
	}
	return {
		steps: steps.slice(0, WEB_RESEARCH_MAX_STEPS),
		stepCount: steps.length,
		hosts,
	};
}

/** URL文字列からホスト名を取り出す。解釈できなければ undefined(ログのために throw しない)。 */
function toHost(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/** URLの配列を上限まで詰めて `{ urls, urlCount }` にする。空なら両方 undefined。 */
function toUrlFields(
	urls: string[],
): Pick<WebResearchStep, "urls" | "urlCount"> {
	if (urls.length === 0) return {};
	return {
		urls: urls.slice(0, WEB_RESEARCH_MAX_URLS_PER_STEP),
		urlCount: urls.length,
	};
}

/** 値が文字列ならそれを、そうでなければ undefined を返す(空文字も undefined 扱い)。 */
function asText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** undefined を落として文字列だけの配列にする。 */
function compact(values: (string | undefined)[]): string[] {
	return values.filter((v): v is string => !!v);
}

/**
 * Anthropic の応答 content から検索の軌跡を組み立てる。
 *
 * 検索1回は **`server_tool_use`(検索語)と `web_search_tool_result`(結果)の2ブロックに
 * 分かれて**現れ、`tool_use_id` で対応づく。ブロックは実行順に並ぶので、直近の未解決な
 * `server_tool_use` に結果を紐づけるのではなく id で引く(pause_turn の継続で
 * 複数レスポンスぶんの content を連結して渡すため、順序だけに頼ると取り違える)。
 *
 * 継続ループがある経路なので、**呼び出し側は全レスポンスの content を連結して渡す**。
 * 各レスポンスは新しいブロックだけを含むので、連結しても重複しない。
 */
export function extractAnthropicTrace(
	content: readonly unknown[] | undefined,
): WebResearchTrace {
	const steps: WebResearchStep[] = [];
	const byToolUseId = new Map<string, WebResearchStep>();
	for (const block of content ?? []) {
		if (!block || typeof block !== "object") continue;
		const {
			type,
			name,
			id,
			input,
			tool_use_id,
			content: result,
		} = block as Record<string, unknown>;

		if (type === "server_tool_use" && name === "web_search") {
			const step: WebResearchStep = {
				action: "search",
				query: asText((input as { query?: unknown } | undefined)?.query),
			};
			steps.push(step);
			const key = asText(id);
			if (key) byToolUseId.set(key, step);
			continue;
		}

		if (type !== "web_search_tool_result") continue;
		// 対応する server_tool_use が見つからない場合も軌跡は残す(検索語が欠けるだけ)。
		const key = asText(tool_use_id);
		let step = key ? byToolUseId.get(key) : undefined;
		if (!step) {
			step = { action: "search" };
			steps.push(step);
		}
		if (Array.isArray(result)) {
			Object.assign(
				step,
				toUrlFields(
					result
						.map((r) => asText((r as { url?: unknown } | null)?.url))
						.filter((u): u is string => !!u),
				),
			);
			continue;
		}
		// 配列でない = web_search_tool_result_error。error_code に打ち切りの理由が入る
		// (max_uses_exceeded なら「上限で裏取りを諦めた」ことがログから分かる)。
		const errorCode = asText(
			(result as { error_code?: unknown } | null)?.error_code,
		);
		step.error = errorCode ?? "unknown";
	}
	return toTrace(steps);
}

/**
 * AI SDK 経由の web検索(プロバイダ実行ツール)の結果から検索の軌跡を組み立てる。
 *
 * 生の Responses API とは**形が2つ違う**ので、素の output 用の抽出器は使い回せない:
 *  - `action.type` が camelCase(`openPage` / `findInPage`)
 *  - 検索結果のURLが `action.sources` ではなく**ツール結果の直下** `output.sources`
 *
 * 素の Responses API と違い `include: ["web_search_call.action.sources"]` は要らない
 * (provider が既定で sources を取り寄せる)。
 *
 * **呼び出し側は全ステップぶんの toolResults を連結して渡す**。エージェントループでは
 * 1リクエストが複数ステップに分かれ、各ステップは自分のぶんだけを持つため。
 */
export function extractAiSdkWebSearchTrace(
	toolResults: readonly unknown[] | undefined,
): WebResearchTrace {
	const steps: WebResearchStep[] = [];
	for (const result of toolResults ?? []) {
		if (!result || typeof result !== "object") continue;
		const { type, output } = result as Record<string, unknown>;
		const out = (output ?? {}) as Record<string, unknown>;
		const act = (out.action ?? {}) as Record<string, unknown>;
		const step: WebResearchStep = { action: "search" };

		if (act.type === "openPage") {
			step.action = "open";
			Object.assign(step, toUrlFields(compact([asText(act.url)])));
		} else if (act.type === "findInPage") {
			step.action = "find";
			step.query = asText(act.pattern);
			Object.assign(step, toUrlFields(compact([asText(act.url)])));
		} else {
			// action.type === "search"(または未知の形)。queries は複数語を1回の呼び出しで
			// 投げることがあるので連結する。query は非推奨の単数形フォールバック。
			const queries = Array.isArray(act.queries)
				? act.queries.map(asText).filter((q): q is string => !!q)
				: [];
			step.query = queries.length > 0 ? queries.join(" | ") : asText(act.query);
			const sources = Array.isArray(out.sources)
				? out.sources
						.map((s) => asText((s as { url?: unknown } | null)?.url))
						.filter((u): u is string => !!u)
				: [];
			Object.assign(step, toUrlFields(sources));
		}

		// 失敗したツール呼び出しは結果ではなくエラーとして届く。軌跡としては
		// 「検索まで行ったが結果を得られなかった」ことが残ればよい。
		if (type === "tool-error") {
			step.error = asText((result as { error?: unknown }).error) ?? "failed";
		}
		steps.push(step);
	}
	return toTrace(steps);
}
