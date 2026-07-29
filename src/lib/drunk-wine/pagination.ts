// マイセラー一覧のページング定数。Web の loader・MCP の入力スキーマ・サービス層が
// 同じ値を見るため、ランタイム非依存の純モジュールに置く(#254)。
// MCP の schemas.ts は `cloudflare:workers` を引き込めないので、サービス層に置くと
// スキーマ側から参照できない(schemas.test.ts が jsdom で読めなくなる)。

/** 一覧のページサイズ既定値(Web一覧のグリッド4列 × 6行ぶん)。 */
export const DRUNK_WINE_PAGE_SIZE = 24;

/** 1回で返す上限。MCP から任意の limit を渡されても、ここで頭打ちにする。 */
export const DRUNK_WINE_MAX_PAGE_SIZE = 100;
