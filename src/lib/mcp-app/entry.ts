// MCP ツールが返す「飲んだワイン」エントリの表現(snake_case)。
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
	drank_on: string | null;
	aop_id: string | null;
	aop_name_ja: string | null;
	region_id: string | null;
	rating: number | null;
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
