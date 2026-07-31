// マイセラーの所有状態のレジストリ(真実の源)。zod(schema.ts)・DB(db/schema.ts の
// $type)・UI のラベルがすべてここから導出される。
//
// 所有状態と飲用履歴は直交する2軸で持つ(Issue #195)。「飲んだことがあるか」は
// wine_tasting の有無(tasting_count > 0)で表し、この列には混ぜない。混ぜると
// 「以前飲んだワインをもう一度購入した」(手元にある かつ 飲んだことがある)が
// 表現できなくなる。
export const WINE_STATUSES = [
	{
		id: "wishlist",
		labelJa: "気になる",
		descriptionJa: "まだ買っていない。飲んでみたい",
	},
	{
		id: "owned",
		labelJa: "セラーにある",
		descriptionJa: "手元にある。まだ飲んでいない、または飲みかけ",
	},
	{
		id: "finished",
		labelJa: "飲み終わった",
		descriptionJa: "手元にない。飲み切った・譲った",
	},
	// 店で見かけただけのワイン(Issue #358)。写真からの一括登録では、写っている
	// ワインのほとんどが「飲んでも所有もしていない」ため、既存3値のどれも合わない。
	// 「どこで見かけたか」は目撃記録(wine_sighting)側が持つ。
	{
		id: "spotted",
		labelJa: "見かけた",
		descriptionJa: "店で見かけただけ。買っても飲んでもいない",
	},
] as const;

export type WineStatus = (typeof WINE_STATUSES)[number]["id"];

export const WINE_STATUS_IDS = WINE_STATUSES.map((s) => s.id) as [
	WineStatus,
	...WineStatus[],
];

/**
 * 既存行(すべて「飲んだワイン」の記録)と、status を送らない旧 MCP クライアントの
 * 既定値。マイグレーションの DEFAULT と必ず同じ値にする。
 */
export const DEFAULT_WINE_STATUS: WineStatus = "finished";

export const WINE_STATUS_LABELS_JA: Record<WineStatus, string> =
	Object.fromEntries(WINE_STATUSES.map((s) => [s.id, s.labelJa])) as Record<
		WineStatus,
		string
	>;

/** 表示優先度(小さいほど優先)。次の行動に近い状態を上に置く */
const STATUS_PRIORITY: Record<WineStatus, number> = {
	owned: 0,
	wishlist: 1,
	finished: 2,
	spotted: 3,
};

/**
 * 1つのAOPに状態の異なる複数エントリがあるとき、地図のマーカーに使う代表の状態を
 * 1つに畳む。「今すぐ飲めるボトルがある」が最も行動に直結するため owned を優先し、
 * 次に wishlist、次に過去の実績(finished)、最後に spotted。エントリが無ければ null。
 *
 * spotted を最下位に置くのは、「店で見かけた」がユーザとそのワインの関係として
 * 最も弱いため。飲んだ実績のあるAOPが、後から同じAOPの別銘柄を1本見かけただけで
 * 「見かけた」色に塗り替わると、地図から読み取れる情報が後退する。
 */
export function pickAopStatus(
	statuses: Iterable<WineStatus>,
): WineStatus | null {
	let best: WineStatus | null = null;
	for (const s of statuses) {
		if (best === null || STATUS_PRIORITY[s] < STATUS_PRIORITY[best]) best = s;
	}
	return best;
}

/**
 * AOPごとの代表状態を作る(地図の色分け用)。AOP未紐付けのエントリは地図に
 * 出せないので落とす。1AOPに複数エントリがあるときの畳み方は pickAopStatus と
 * 同じ優先度で、ここが「AOP単位の状態」の唯一の導出口になる。
 */
export function buildAopStatusMap(
	entries: Iterable<{ aopId: string | null; status: WineStatus }>,
): Map<string, WineStatus> {
	const byAop = new Map<string, WineStatus>();
	for (const e of entries) {
		if (!e.aopId) continue;
		const current = byAop.get(e.aopId);
		const next = pickAopStatus(current ? [current, e.status] : [e.status]);
		if (next) byAop.set(e.aopId, next);
	}
	return byAop;
}

/**
 * 状態の異なるエントリを持つAOPが1つでもあるか。地図の凡例に「混在は owned を
 * 優先して表示している」という注記を出すかの判定に使う。
 *
 * 絞り込みチップ(filter.ts)から導出してはいけない。チップは所有状態と1対1では
 * なく、"tasted"(飲んだことがある)は所有状態と直交するため owned と finished が
 * 同居しうるし、"finished" のチップはそもそも存在しない。実データを見るのが唯一
 * 正確で、混在が無いときに注記を出さずに済む。
 */
export function hasMixedAopStatus(
	entries: Iterable<{ aopId: string | null; status: WineStatus }>,
): boolean {
	const seen = new Map<string, WineStatus>();
	for (const e of entries) {
		if (!e.aopId) continue;
		const prev = seen.get(e.aopId);
		if (prev !== undefined && prev !== e.status) return true;
		seen.set(e.aopId, e.status);
	}
	return false;
}

/** 飲んだことがあるか。所有状態には依存しない(2軸が独立しているため) */
export function isTasted(entry: { tastingCount: number }): boolean {
	return entry.tastingCount > 0;
}
