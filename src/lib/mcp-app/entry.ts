// MCP ツールが返すマイセラーのエントリ表現(snake_case)。
//
// 生成側は tools.ts の toEntryPayload、消費側は MCP App のフォーム
// (/embed/drunk-wine)。両者はプロセスも信頼境界も異なる(ホスト仲介の
// postMessage 越し)ため、形の単一情報源としてこの型を挟む。toEntryPayload の
// 戻り型に注釈することで、片側だけキーが増減したらコンパイルで落ちる。
//
// このモジュールはランタイム非依存に保つ(cloudflare:workers を import しない)。
// MCP App は jsdom 上のユニットテストから、ツール側は workerd から参照する。
export interface McpDrunkWineEntry {
	id: string;
	name: string;
	/** 所有状態: "wishlist" | "owned" | "finished" */
	status: string;
	/** 最新の飲用記録の飲んだ日。飲用記録が無い/全件日付未入力なら null */
	last_drank_on: string | null;
	/** 飲用記録の件数。0 なら「まだ飲んだことがない」 */
	tasting_count: number;
	/** 最新の飲用記録の飲んだ日(last_drank_on と同値)。既存クライアント互換で残す */
	drank_on: string | null;
	aop_id: string | null;
	aop_name_ja: string | null;
	/** 表示用の地域(AOPからの導出込み)。地域単位の紐付けなら保存値 */
	region_id: string | null;
	/** 表示用の国(AOP/地域からの導出込み)。国単位の紐付けなら保存値 */
	country_id: string | null;
	/** 最新の飲用記録の評価。既存クライアント互換で残す */
	rating: number | null;
	/** 最新の飲用記録のメモ。既存クライアント互換で残す */
	memo: string | null;
	vintage: number | null;
	grape_variety_ids: string[];
	producer: string | null;
	price: number | null;
	/** 全写真の絶対URL(表示順・先頭が代表)。 */
	photo_urls: string[];
	/** 後方互換の代表1枚。 */
	photo_url: string | null;
	created_at: number;
	updated_at: number;
}

// ホストから postMessage で届くエントリ。送信元はホスト実装であり、
// フォームから見れば外部入力なので「id が文字列であること」以外は仮定しない。
export type ReceivedDrunkWineEntry = {
	id: string;
} & Partial<McpDrunkWineEntry>;
