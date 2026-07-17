// 乱数を注入可能にするためのユーティリティ。本番は Math.random、
// テストは mulberry32(seed) を渡して全ジェネレータを決定的に検証する。

/** [0, 1) の乱数を返す関数 */
export type Rng = () => number;

/** シード付き決定的乱数(テスト用) */
export function mulberry32(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher–Yates。元配列は変更せず新しい配列を返す */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		// i, j はループ条件で常に有効な添字。型アサーションは実行時no-opなので、
		// T が undefined を含む要素型でも値をそのまま入れ替えられる(ガードだと誤って
		// 正当な undefined 要素を弾いてしまう)。
		[result[i], result[j]] = [result[j] as T, result[i] as T];
	}
	return result;
}

/** 非復元サンプリング。count が要素数を超える場合は全要素を返す */
export function sample<T>(items: readonly T[], count: number, rng: Rng): T[] {
	return shuffle(items, rng).slice(0, count);
}

/**
 * 重み付き非復元サンプリング。重みに比例した確率で順に抜き取る。
 * 重みが全て0のときは一様に選ぶ。
 */
export function sampleWeighted<T>(
	items: readonly T[],
	count: number,
	weightOf: (item: T) => number,
	rng: Rng,
): T[] {
	const pool = [...items];
	const picked: T[] = [];
	while (picked.length < count && pool.length > 0) {
		const weights = pool.map((item) => Math.max(weightOf(item), 0));
		const total = weights.reduce((sum, w) => sum + w, 0);
		let index: number;
		if (total <= 0) {
			index = Math.floor(rng() * pool.length);
		} else {
			let r = rng() * total;
			index = pool.length - 1;
			for (let i = 0; i < weights.length; i++) {
				r -= weights[i] ?? 0;
				if (r < 0) {
					index = i;
					break;
				}
			}
		}
		// index は上の分岐で pool の有効範囲(0..length-1)に収めているので必ず存在する。
		picked.push(pool[index] as T);
		pool.splice(index, 1);
	}
	return picked;
}
