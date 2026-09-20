// 高精度エチケット解析(LLM + web検索)の**検索の軌跡**を、プロバイダ非依存の形へ
// 畳むための純ロジック。
//
// この経路の精度は「web検索で裏を取る」ことから来ているのに、そこで何を検索し何を
// 読んだかは応答の外からは一切見えなかった。結果として推定がおかしかったときに、
// 「読み取りを間違えた」のか「検索で拾った情報が間違っていた」のかを切り分ける手段が
// 無い(検索結果は毎回変わるので、後から同じ写真で再実行しても再現しない)。実行時に
// 拾って実行記録へ載せる以外に観測手段が無いため、ここで軌跡を組み立てる。
//
// #602 で全経路を OpenRouter の chat completions へ集約した。検索は
// `openrouter:web_search` サーバーツールとして OpenRouter 側で実行されるため、
// 検索語クエリは応答に出ない。応答メッセージの `annotations`(url_citation)から
// 参照 URL を拾い、引用の裏取り検証と観測に必要な形へ畳む。
//
// 応答の型には合わせにいかず unknown で受けて絞り込む: 応答の形が版ごとに増え、
// テスト用のダミー値が組み立てられなくなる。ここで拾えなかったブロックは黙って
// 無視され、ログが少し痩せるだけで解析そのものは壊れない、という失敗の仕方に倒す。

/** 1操作ぶんの軌跡。 */
interface WebResearchStep {
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
 * 1行に載せる操作数の上限。`max_uses` で縛れるとはいえ、エージェントループでは
 * 複数リクエストぶんが積まれるので、ログ行の肥大化はここで止める。
 */
export const WEB_RESEARCH_MAX_STEPS = 20;

/** 1操作あたりに載せるURLの数。検索は10件前後返るが、全件を残すと1行が肥大化する。 */
export const WEB_RESEARCH_MAX_URLS_PER_STEP = 5;

/** `hosts` に載せる一意ホストの上限。 */
const WEB_RESEARCH_MAX_HOSTS = 30;

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

/**
 * OpenRouter の応答メッセージの `annotations`(url_citation)から検索の軌跡を組み立てる。
 *
 * サーバーツールとして実行された検索は検索語クエリを応答に残さないため、参照 URL
 * だけを拾う。引用の裏取り検証(`verifyLabelAnswer`)はホスト単位で照合するので、
 * URL があれば足りる。検索語が要る分析は `usage.server_tool_use` の回数と
 * 併せて読む。
 */
export function extractOpenRouterTrace(
	annotations: readonly unknown[] | undefined,
): WebResearchTrace {
	const urls: string[] = [];
	for (const annotation of annotations ?? []) {
		if (!annotation || typeof annotation !== "object") continue;
		const citation = (annotation as { url_citation?: unknown }).url_citation;
		if (!citation || typeof citation !== "object") continue;
		const url = asText((citation as { url?: unknown }).url);
		if (url) urls.push(url);
	}
	if (urls.length === 0) return toTrace([]);
	return toTrace([{ action: "search", ...toUrlFields(urls) }]);
}

/**
 * 複数リクエストぶんの軌跡を1つに畳む(エージェントループの各ステップで積む)。
 * 操作は実行順のまま連結し、上限の適用は `toTrace` に任せる。
 */
export function concatWebResearchTraces(
	traces: readonly WebResearchTrace[],
): WebResearchTrace {
	return toTrace(traces.flatMap((t) => t.steps));
}
