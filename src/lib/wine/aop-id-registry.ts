import knownAopIds from "./aop-known-ids.json";

// AOP ID の安定性を担保する台帳(#333)。
//
// `drunk_wine.aop_id` と `aop_reference_link.aop_id` は静的マスタ(aops.json)への
// **FK 無しの文字列参照**で、存在検証は書き込み時にしか走らない。そのため aops.json から
// ID を消す・スラッグを変えると、それ以前に登録された本番D1の行が静かに壊れる:
// マイセラーで AOP 名と地域が消える / セラー地図から落ちて「未紐付け」に合算される /
// その AOP に保存した参考リンクが閲覧も削除もできない到達不能データになる。
//
// 実際に #216(2022年格付けから離脱した La Gaffelière)で winery エントリの削除が起きており、
// 生産者拡充・格付け整理の PR が頻繁に aops.json を編集する以上、今後も起こりうる。
// そこで「ID を消す・変える」を検知不能な事故ではなく、**明示的な手続き**にする:
//
//  1. 出荷された ID は aop-known-ids.json(append-only の台帳)に残る
//     — `bun run sync:aop-ids` が追記する。手で消さない
//  2. 台帳にあるのに aops.json から消えた ID は、下の RETIRED_AOP_IDS への記載を必須にする
//     — 記載が無ければ data-integrity.test.ts が CI で落ちる
//  3. 記載された ID は getAop() が後継 AOP へ解決する
//     — 既存D1行は表示・地図・参考リンクとも後継 AOP のものとして生き続ける

/** これまでに一度でも aops.json に載った AOP ID(append-only)。 */
export const KNOWN_AOP_IDS: readonly string[] = knownAopIds;

/**
 * aops.json から取り除かれた ID → 後継 AOP の ID。
 *
 * 後継には「その ID で登録された既存のワイン・参考リンクを、今後どの AOP のものとして
 * 扱うか」を書く。シャトー(winery)の廃止・格付け離脱なら、そのシャトーが属する AOC が
 * 妥当な後継になる。純粋な改名なら新しいスラッグを書く。
 *
 * `null` は「後継無し」の明示。既存行は未解決のまま残り、実行時に警告ログが出る
 * (drunk-wine-service / reference-link-service)。**安易に null にしない**。
 */
export const RETIRED_AOP_IDS: Readonly<Record<string, string | null>> = {
	// #216: 2022年のサンテミリオン格付けから離脱したため winery エントリごと削除された。
	// 登録済みのワインは AOC サンテミリオン・グラン・クリュのものとして扱う
	// (シャトーが消えても、そのワインの AOC は変わらない)。
	"chateau-la-gaffeliere": "saint-emilion-grand-cru",
};
