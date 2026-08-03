import { env } from "cloudflare:workers";
import { logWarn } from "#/lib/logger";

// アプリ側エンドポイントのスロットル(#397)。**Cloudflare Workers の Rate Limiting
// バインディング**(2025-09 に GA)を使う。
//
// なぜ D1 の rate_limit テーブル(better-auth が /api/auth/* で使っているもの)を
// 流用しないか:
//  - #397 が防ぎたいのは「従量コストの増加」そのもの。全リクエストで D1 に読み書きする
//    スロットルは、それ自体が D1 の行読み書きとレイテンシを毎回積む。守る対象と同じ
//    コストを増やす形になる。
//  - Rate Limiting バインディングはエッジのカウンタで、D1 も KV も消費しない。
//
// **性質の理解が要る**(Cloudflare のドキュメント):
//  - カウンタは **colo(データセンター)ごと**。全世界で厳密に N 回ではなく、
//    実効上限は「N × リクエストが届いた colo 数」になりうる。
//  - 意図的に「正確な会計ではない」設計で、瞬間的に上限を超えることがある。
//
// したがってこれは**濫用のスロットル**であって、正確な割当(クォータ)ではない。
// 「1ユーザあたりのエントリ数・写真総バイト数」のような**累積の上限**は別物で、
// D1 で数えて判定する必要がある(#397 の残作業)。ここで代用してはならない。
//
// キーは **userId** を使う(IPはNAT等で多数の利用者に共有されるため、ドキュメントも
// 安定した識別子を推奨している)。#397 の脅威モデルも「1アカウント作れば」なので、
// アカウント単位で絞るのが正しい。

/**
 * スロットルの用途。用途ごとに上限が違うため、バインディングも分ける
 * (limit/period はバインディング単位の設定で、実行時には変えられない)。
 *
 * 実際の上限値は wrangler.jsonc の `ratelimits` が正。ここは対応付けだけを持つ。
 */
export const RATE_LIMITERS = {
	/** server function の書き込み全般。 */
	write: "RATE_LIMIT_WRITE",
	/** 画像アップロード系 API ルート(R2 の書き込みを伴う)。 */
	upload: "RATE_LIMIT_UPLOAD",
	/** 任意URLへの外部fetch(参考リンクのタイトル取得)。外部への送信リレーになるため最も厳しい。 */
	fetchTitle: "RATE_LIMIT_FETCH_TITLE",
} as const satisfies Record<string, keyof Cloudflare.Env>;

export type RateLimiterName = keyof typeof RATE_LIMITERS;

/** バインディング未設定を報告済みの用途(isolate 内で1回だけ警告する)。 */
const warnedMissing = new Set<string>();

/**
 * バインディングを引く。**未設定でも動作は止めない**。
 *
 * バインディングは wrangler.jsonc の設定なので、設定漏れ・古いプレビュー・
 * ローカルの実験環境では存在しないことがある。ここで throw すると
 * 「スロットルの設定漏れでアプリ全体が落ちる」ことになり、守ろうとしている
 * 可用性を自分で壊す。素通しさせたうえで警告を残し、ログから気づけるようにする。
 */
function limiterFor(name: RateLimiterName): RateLimit | undefined {
	const binding = RATE_LIMITERS[name];
	// **静的なプロパティアクセスで引く**(`env[binding]` の動的参照にしない)。
	// バインディングの解決はバンドラ/ランタイムの実装に依存する部分があり、動的参照だと
	// 環境によって undefined になりうる。ここが undefined でも設計上は素通しに倒れるため、
	// 「設定はあるのに効かない」状態が黙って成立してしまう(実際にプレビューで踏んだ)。
	const limiter =
		name === "write"
			? env.RATE_LIMIT_WRITE
			: name === "upload"
				? env.RATE_LIMIT_UPLOAD
				: env.RATE_LIMIT_FETCH_TITLE;
	if (!limiter) {
		if (!warnedMissing.has(binding)) {
			warnedMissing.add(binding);
			logWarn(
				"rate limit binding is not configured; requests pass unthrottled",
				{
					limiter: name,
					binding,
				},
			);
		}
		return undefined;
	}
	return limiter;
}

/**
 * 上限内かどうかを返す。超過なら false。
 *
 * 判定そのものが失敗した場合(バインディング未設定・エッジ側のエラー)は **true(通す)**
 * に倒す。スロットルは濫用対策であって認可ではないので、故障時に正規の利用者を
 * 締め出す方が損失が大きい。
 *
 * **超過の記録はここで行う**(呼び出し側に散らさない)。超過は正常系(攻撃でも操作ミスでも
 * 起きる)なので logError ではなく logWarn に留め、障害シグナルを薄めない。
 * 拒否の表現は経路ごとに違う(server function は throw、API ルートは Response)ため、
 * ここは真偽値だけを返して呼び出し側に委ねる。
 */
export async function withinRateLimit(
	name: RateLimiterName,
	key: string,
	context: { userId?: string; path?: string } = {},
): Promise<boolean> {
	const limiter = limiterFor(name);
	if (!limiter) return true;
	try {
		const { success } = await limiter.limit({ key });
		if (!success) logWarn("rate limited", { limiter: name, ...context });
		return success;
	} catch (err) {
		logWarn("rate limit check failed; request passes unthrottled", {
			limiter: name,
			err,
		});
		return true;
	}
}
