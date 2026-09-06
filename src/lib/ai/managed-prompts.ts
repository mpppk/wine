// Langfuse のプロンプト管理下にあるプロンプトの登録簿(#512 Phase 4)。
//
// **本文のSSOTは Langfuse 側にある。** ここに置く `template` は2つの役割しか持たない:
//  1. Langfuse が使えないとき(キー未設定・取得失敗・壊れた版)の fallback
//  2. `bun run sync:prompts` で Langfuse へ初期登録するときの種
//
// この転換は #512 本文の「Langfuse Prompts は使わない」を意図的に覆したもの。
// デプロイと無関係にモデルの挙動が変わることを許容し、代わりに評価のループ
// (編集 → preview で試す → production へ昇格 → ラベルを戻して巻き戻し)を優先する。
// 失われる「型とテストによる保証」は `langfuse-prompt.ts` の実行時ガードで補う。
//
// **このファイルは env にもマスタデータにも依存させない。** workerd 上の
// `langfuse-prompt.ts` と Bun 上の `scripts/sync-langfuse-prompts.ts` の両方が読み、
// unit テスト(jsdom)からも読む。マスタ由来の一覧(呼称・品種など)を将来ここへ
// 足すときは、テンプレートへ焼き込まずに**変数として実行時に注入する**こと
// (焼き込むと `aops.json` を更新するたびに Langfuse への再登録が要る上、
// クライアントバンドルへマスタが載る)。

/** Langfuse で管理する1本のプロンプト。 */
export interface ManagedPromptDefinition {
	/** Langfuse 上のプロンプト名。ラベル(`production` / `preview`)で版を選ぶ。 */
	name: string;
	/** fallback 兼 初期登録の種。`{{変数名}}` で変数を埋め込む。 */
	template: string;
	/**
	 * このプロンプトが必ず要求する変数。
	 *
	 * `compile()` は `Record<string, string>` を取るので型で守れない。実行時ガード
	 * (`langfuse-prompt.ts`)が「取得した版にこれが全て現れるか」を検査し、欠けていれば
	 * fallback へ落とす —— Langfuse 側で `{{region_context}}` を消されたときに
	 * グラウンディングが黙って消滅するのを防ぐ。
	 */
	variables: readonly string[];
}

/**
 * テンプレート中の `{{変数名}}` を列挙する(重複は畳む)。
 *
 * 数えるのは `{{名前}}` の形だけ。mustache のセクション(`{{#x}}` / `{{/x}}` / `{{^x}}`)や
 * コメント(`{{!x}}`)は**変数として数えない**(名前に使える文字を英数字と `_` に限っているため)。
 * この登録簿に置く `template` 自身は単純な差し込みだけで書く —— fallback の差し込みは
 * `compileFallbackTemplate` の素朴な置換で行うため、制御構文を書くと展開されない。
 * Langfuse 側の版は SDK の mustache で展開されるので制御構文も動く。
 */
export function extractTemplateVariables(template: string): string[] {
	const found = new Set<string>();
	for (const m of template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
		const name = m[1];
		if (name) found.add(name);
	}
	return [...found];
}

/**
 * 地域Q&A の system プロンプト。ガードレールだけを持ち、閲覧中のページの地域情報は
 * `region_context` として実行時に注入する(`buildRegionContext` が組み立てる)。
 */
export const REGION_QA_SYSTEM_PROMPT: ManagedPromptDefinition = {
	name: "region-qa-system",
	template: [
		"あなたはワインに関する学習を助ける日本語アシスタントです。",
		"ユーザからの質問に対して簡潔(3〜5文程度)な日本語で答えてください。",
		"- ワインの学習に無関係な質問には丁寧に断る。",
		"- 事実を創作しない。",
		"",
		"なお、以下はユーザが現在閲覧しているページの情報です。これを踏まえた回答を行なってください",
		"# 地域情報",
		"{{region_context}}",
	].join("\n"),
	variables: ["region_context"],
};

/**
 * エチケット解析の Claude 経路(label-web-research.ts)への指示文。
 *
 * マスタ由来の一覧はテンプレートへ焼き込まず `known_lists` として実行時に注入する
 * (`buildKnownListsSection()` が組み立てる)。**fallback がコードのビルダーと
 * 一致することは `label-extraction.test.ts` が固定する**——どちらかを変えたら
 * もう一方も変える。
 */
export const LABEL_WEB_RESEARCH_PROMPT: ManagedPromptDefinition = {
	name: "label-web-research",
	template: [
		"これはワインのボトル/エチケット(ラベル)の写真です(同一ボトルの表・裏ラベルなど複数枚のことがあります)。",
		"以下の手順でこのワインの情報を特定し、最後にJSONオブジェクトだけを出力してください。",
		"",
		"1. 全ての写真からワイン名・生産者・ヴィンテージ・原産地呼称・地域・品種を読み取る。",
		"2. web検索で裏取りする。生産者の公式サイト、Wine-Searcher・Vivino等のワインデータベース、輸入元の商品ページ、原産地呼称の公式情報を優先して参照する。",
		"   - 生産者名・ワイン名の綴りを正式表記に正す(写真の読み取り誤りを修正する)。",
		"   - 原産地呼称はラベルに明記されていなくても、このワインの正式なAOC/AOP/DOC/DOCG等を特定する。",
		"   - 品種はラベルに無記載でも、生産者情報・ワインデータベースで確認できたセパージュを列挙する(推測は不可。検索で確認できた場合のみ)。",
		"   - ヴィンテージは写真から読めた値を最優先する。写真から読めない場合は null にする(検索結果から創作しない)。",
		"   - **香り・味わいの評価と生産者の紹介も併せて拾う**(コメントの材料。下の tasting_comment / producer_comment)。",
		"3. 出力するJSONのフィールド:",
		'   - "wine_name": キュヴェ名等を含む正式なワイン名(原語)。無ければ null',
		'   - "producer": 生産者/ドメーヌ/シャトー名(原語の正式表記)。無ければ null',
		'   - "vintage": 西暦の整数(例: 2020)。不明なら null',
		'   - "appellation": 正式な原産地呼称(原語)。不明なら null',
		'   - "region": 地域名(例: Bourgogne, Bordeaux, Toscana)。不明なら null',
		'   - "country": 生産国(例: France, Italy)。不明なら null',
		'   - "grape_varieties": 品種名(原語)の文字列配列。確認できなければ空配列',
		'   - "reference_links": 参考にしたページの一覧(最大3件)。各要素は { "title": ページのタイトル(原語のまま。分からなければ null), "url": 実際に開いたページのURL }。',
		"     生産者の公式サイト・ワインデータベース・輸入元の商品ページなど、裏取りに使ったページだけを入れる。",
		"     実際に開いていないURLを書かない。参考にしたページが無ければ空配列。",
		'   - "prices": このワインの販売価格の一覧(最大3件)。各要素は { "source": 店・サイト名(例: ドメイン名), "amount_jpy": 日本円の整数, "url": 価格を見たページのURL(無ければ null) }。',
		"     日本円で表示されていたものだけを入れる(外貨は換算せず、amount_jpy を null にする)。見つからなければ空配列。",
		'   - "sources": 上記7フィールドそれぞれの根拠。キーはフィールド名と同じで、値は',
		'     { "origin": "photo" | "web" | "photo_and_web" | "unknown", "url": 文字列 or null }。',
		'     - "photo": 写真から読み取ってそのまま採用した',
		'     - "web": 写真には無く、検索で確認して補った',
		'     - "photo_and_web": 写真から読み取った値を検索で裏取り・修正した',
		'     - "unknown": 特定できず null / 空配列にした',
		'     "url" は origin が "web" / "photo_and_web" のとき、実際に参照したページのURLを1つ入れる。',
		"     それ以外は null。**URLを創作しない**(実際に開いていないURLを書かない)。",
		'   - "tasting_comment": このワインの香り・味わいについての日本語のコメント(1〜3文)。',
		"     **web検索で見つかった評価・テイスティングコメント・販売ページの説明に現れる表現を踏まえて**書く。",
		"     複数の評価に共通する特徴(果実味・酸・タンニン・熟成香など)を自分の言葉でまとめること。",
		"     特定のページの文章をそのまま引き写さない。検索で何も見つからなければ null(推測で書かない)。",
		'   - "producer_comment": 生産者についての日本語のコメント(1〜2文)。所在地・歴史・造りの特徴など。',
		"     確認できなければ null。",
		"4. 検索しても確認できない項目は null にする。JSONの前後に説明文・コードフェンスを書かない。",
		"",
		"{{known_lists}}",
	].join("\n"),
	variables: ["known_lists"],
};

/**
 * エチケット解析の GPT エージェントループ経路(label-gpt-research.ts)への指示文。
 *
 * 呼称の一覧は同梱せず `search_appellation` に置き換えているため、注入するのは
 * 品種の一覧(`known_grapes`)だけ。fallback とコードの一致は
 * `label-extraction.test.ts` が固定する。
 */
export const LABEL_AGENT_RESEARCH_PROMPT: ManagedPromptDefinition = {
	name: "label-agent-research",
	template: [
		"これはワインのボトル/エチケット(ラベル)の写真です(同一ボトルの表・裏ラベルなど複数枚のことがあります)。",
		"ツールを使って調べながら、このワインを特定してください。**推測で埋めず、裏を取ってから提出すること。**",
		"",
		"1. 全ての写真からワイン名・生産者・ヴィンテージ・原産地呼称・地域・品種を読み取る。",
		"   **文字が小さくて読めない場合は zoom_photo で拡大して読み直すこと。** ボトル全体が写った写真では",
		"   ラベルの文字は潰れて読めないのが普通で、拡大すれば読めることが多い。生産者名が読めないまま",
		"   web検索に頼ると、条件の合う別のワインを掴んでしまう。**読めないなら推測せず、まず拡大する。**",
		"   - **小さな説明文まで読むこと。** 大きく印字された生産者名は瓶の曲面や見切れで欠けやすいが、",
		"     裏ラベルの説明文(畑・土壌・歴史の紹介)や輸入元表示に正式名が現れることが多い。",
		"     大きな文字が欠けていても諦めず、本文を拡大して探す。",
		"2. web検索で裏取りする。生産者の公式サイト、Wine-Searcher・Vivino等のワインデータベース、輸入元の商品ページ、原産地呼称の公式情報を優先して参照する。",
		"   - 生産者名・ワイン名の綴りを正式表記に正す(写真の読み取り誤りを修正する)。",
		"   - 原産地呼称はラベルに明記されていなくても、このワインの正式なAOC/AOP/DOC/DOCG等を特定する。",
		"   - 品種はラベルに無記載でも、生産者情報・ワインデータベースで確認できたセパージュを列挙する(推測は不可。検索で確認できた場合のみ)。",
		"   - ヴィンテージは写真から読めた値を最優先する。写真から読めない場合は null にする(検索結果から創作しない)。",
		"3. 呼称と生産者はこのアプリのマスタとも突き合わせる。",
		"   - search_appellation: 読み取った呼称の綴りが不確かなときに候補を引く。マスタに該当があれば、その正式表記を一字一句そのまま使う。",
		"   - get_appellation: 呼称の許可品種・生産者・格付けを引く。読み取った品種がその呼称で認められているかの確認に使う。",
		"   - lookup_producer: **生産者名から呼称を逆引きする**。ラベルの呼称が欠けている・読めないときの主要な手がかり。",
		"   - マスタは対応地域ぶんしか無いので、**引けなくても誤りとは限らない**。その場合はweb検索の結果を優先してよい。",
		"4. 確信が持てたら submit_answer で提出する。引数のフィールド:",
		'   - "wine_name": キュヴェ名等を含む正式なワイン名(原語)。無ければ null',
		'   - "producer": 生産者/ドメーヌ/シャトー名(原語の正式表記)。無ければ null',
		'   - "vintage": 西暦の整数(例: 2020)。不明なら null',
		'   - "appellation": 正式な原産地呼称(原語)。不明なら null',
		'   - "region": 地域名(例: Bourgogne, Bordeaux, Toscana)。不明なら null',
		'   - "country": 生産国(例: France, Italy)。不明なら null',
		'   - "grape_varieties": 品種名(原語)の文字列配列。確認できなければ空配列',
		'   - "reference_links": 参考にしたページの一覧(最大3件)。各要素は { "title": ページのタイトル(原語のまま。分からなければ null), "url": 実際に開いたページのURL }。',
		"     生産者の公式サイト・ワインデータベース・輸入元の商品ページなど、裏取りに使ったページだけを入れる。",
		"     実際に開いていないURLを書かない。参考にしたページが無ければ空配列。",
		'   - "prices": このワインの販売価格の一覧(最大3件)。各要素は { "source": 店・サイト名(例: ドメイン名), "amount_jpy": 日本円の整数, "url": 価格を見たページのURL(無ければ null) }。',
		"     日本円で表示されていたものだけを入れる(外貨は換算せず、amount_jpy を null にする)。見つからなければ空配列。",
		'   - "sources": 上記7フィールドそれぞれの根拠。キーはフィールド名と同じで、値は',
		'     { "origin": "photo" | "web" | "photo_and_web" | "unknown", "url": 文字列 or null }。',
		'     - "photo": 写真から読み取ってそのまま採用した',
		'     - "web": 写真には無く、検索で確認して補った',
		'     - "photo_and_web": 写真から読み取った値を検索で裏取り・修正した',
		'     - "unknown": 特定できず null / 空配列にした',
		'     "url" は origin が "web" / "photo_and_web" のとき、実際に参照したページのURLを1つ入れる。',
		"     それ以外は null。**URLを創作しない**(実際に開いていないURLを書かない)。",
		'   - "tasting_comment": このワインの香り・味わいについての日本語のコメント(1〜3文)。',
		"     **web検索で見つかった評価・テイスティングコメント・販売ページの説明に現れる表現を踏まえて**書く。",
		"     複数の評価に共通する特徴(果実味・酸・タンニン・熟成香など)を自分の言葉でまとめること。",
		"     特定のページの文章をそのまま引き写さない。検索で何も見つからなければ null(推測で書かない)。",
		'   - "producer_comment": 生産者についての日本語のコメント(1〜2文)。所在地・歴史・造りの特徴など。',
		"     確認できなければ null。",
		"5. submit_answer は検証を行う。問題が返ってきたら、指摘された点を調べ直して再度 submit_answer を呼ぶこと。",
		"   同じ答えをそのまま再提出しない。確認できない項目は null / 空配列にして提出してよい。",
		"",
		"{{known_grapes}}",
	].join("\n"),
	variables: ["known_grapes"],
};

/**
 * 一括抽出(wine-list-extraction.ts)の指示文。Claude 経路と GPT 経路が共有する。
 *
 * 写真の枚数は `photo_count` として注入する(数値でも文字列変数として渡す)。
 * マスタの一覧は `known_lists`。fallback とコードの一致は
 * `wine-list-extraction.test.ts` が固定する。
 */
export const WINE_LIST_RESEARCH_PROMPT: ManagedPromptDefinition = {
	name: "wine-list-research",
	template: [
		"これは飲食店のワインリスト、ワインショップの陳列・棚・ポップ、または1本のワインのボトル・エチケット(ラベル)を撮影した写真です",
		"(全{{photo_count}}枚。各写真の直前に「写真 N」と番号を記載しています)。",
		"写真に写っているワインの銘柄をすべて列挙し、最後にJSONオブジェクトだけを出力してください。",
		"",
		"1. すべての写真を読み、記載されているワインを1銘柄ずつ拾う。ヘッダー・グラスワインの区分見出し・店名などワインの銘柄でないものは拾わない。",
		"2. **同じ銘柄が複数の写真に写っている場合は1件に統合する**。生産者・ワイン名・ヴィンテージがすべて一致するものを同一銘柄とみなし、photo_indexes に写っていた写真番号をすべて入れる。ヴィンテージが違うものは別の銘柄として分ける。",
		"3. **web検索で裏を取る**。生産者の公式サイト・ワインデータベースを引き、綴りの誤り(写真の文字が潰れて読めた分)を直し、原産地呼称を特定し、ラベルに書かれていないセパージュを補う。検索は銘柄をまとめて調べてよい(1銘柄ごとに何度も検索し直さない)。",
		"4. **裏取りできなかった項目は写真から読めた値のままにする**。検索結果が見つからない・確信が持てない場合に、それらしい値を創作しない。写真からも読めず裏も取れない項目は null にする。",
		"5. 出力するJSONは次の形にする:",
		'   - "wines": 銘柄の配列。各要素は',
		'     - "wine_name": ワイン名(キュヴェ名等を含む。原語のまま)。読めなければ null',
		'     - "producer": 生産者/ドメーヌ/シャトー名。読めなければ null',
		'     - "vintage": 西暦の整数(例: 2020)。記載が無い/NV(ノンヴィンテージ)なら null',
		'     - "appellation": 原産地呼称(AOC/AOP/DOC/DOCG など)。下の既知リストに該当があればその表記を一字一句そのまま使う。読めなければ null',
		'     - "region": 地域名(例: Bourgogne, Toscana)。読めなければ null',
		'     - "country": 生産国(例: France, Italy)。読めなければ null',
		'     - "grape_varieties": 品種名の文字列配列。記載が無ければ空配列。下の既知リストに該当があればその表記を使う',
		'     - "price": リスト記載の価格を整数(日本円)で。グラスとボトルが併記されていればボトルの価格。記載が無ければ null',
		'     - "photo_indexes": この銘柄が写っていた写真番号(0始まり)の配列',
		'     - "bottle_photo_index": **その1本だけを写した写真**(ボトル単体・エチケットのクローズアップ)があればその番号。',
		"       リストやメニュー、棚に並んだ状態しか写っていない銘柄は null。銘柄の写真として使えるかで判断する",
		'     - "image_url": bottle_photo_index が null の場合のみ、web検索で見つけたこのワインのボトル/エチケット画像の直リンク。',
		"       画像そのもののURL(.jpg/.png/.webp 等)で、実際に検索結果として見たものだけを書く。**URLを創作しない**。見つからなければ null",
		'     - "image_note": image_url の画像が実物と違う点(ヴィンテージが別の年、同じ生産者の別キュヴェ 等)。一致していれば null',
		'     - "tasting_comment": 香り・味わいの日本語コメント。**1〜2文で簡潔に**。web検索で見つかった評価・販売ページの説明に現れる表現を踏まえ、',
		"       複数の評価に共通する特徴を自分の言葉でまとめる。特定のページの文章をそのまま引き写さない。見つからなければ null(推測で書かない)",
		'     - "producer_comment": 生産者についての日本語コメント。**1文で簡潔に**。確認できなければ null',
		'     - "reference_links": 裏取りに使ったページの一覧(1銘柄あたり最大3件)。各要素は { "title": ページのタイトル(原語のまま。分からなければ null), "url": 実際に開いたページのURL }。',
		"       実際に開いていないURLを書かない。参考にしたページが無ければ空配列",
		'     - "prices": このワインの販売価格の一覧(1銘柄あたり最大3件)。各要素は { "source": 店・サイト名(例: ドメイン名), "amount_jpy": 日本円の整数, "url": 価格を見たページのURL(無ければ null) }。',
		"       日本円で表示されていたものだけを入れる(外貨は換算せず、amount_jpy を null にする)。見つからなければ空配列",
		'   - "subject": 写真群の被写体。**すべての写真が同じ1本のワインだけを写している**場合(ボトル単体・エチケット・裏ラベル・箱・ネックタグのクローズアップなど)は "single_wine"、飲食店のワインリスト・ショップの陳列や棚・複数の銘柄が写っている場合は "wine_list"',
		'   - "truncated": 列挙しきれなかった銘柄が残っている場合は true、すべて列挙できたなら false',
		'6. subject の判定は迷ったら "wine_list" にする。1本のワインだと確信できる場合にだけ "single_wine" にする。',
		"7. 銘柄数が多くても省略・要約しない。どうしても出力が長くなりすぎる場合のみ途中で打ち切り、その場合は truncated を true にする。",
		"8. コメント(tasting_comment / producer_comment)は**全銘柄ぶん書く**。ただし銘柄数が多いほど出力が膨らむので、1銘柄あたりは必ず短く保つこと。",
		"9. 写真は銘柄ごとに1枚を用意する。手元の写真で足りるなら bottle_photo_index を優先し、無い銘柄だけ image_url を探す(検索は銘柄をまとめて調べてよい)。",
		"10. JSONの前後に説明文・コードフェンスを書かない。",
		"",
		"{{known_lists}}",
	].join("\n"),
	variables: ["known_lists", "photo_count"],
};

/**
 * Langfuse 管理下のプロンプト全件。実行時・同期スクリプト・テストが同じ定義を読む。
 * **ここに載っていないプロンプトは Langfuse を見ない**(コードがそのまま正)。
 */
export const MANAGED_PROMPTS: readonly ManagedPromptDefinition[] = [
	REGION_QA_SYSTEM_PROMPT,
	LABEL_WEB_RESEARCH_PROMPT,
	LABEL_AGENT_RESEARCH_PROMPT,
	WINE_LIST_RESEARCH_PROMPT,
];

/** `checkTemplateVariables` の結果。両方空なら、その版はコードが差し込める。 */
export interface TemplateVariableMismatch {
	/** 必須なのにテンプレートから消えている変数。 */
	missing: string[];
	/** テンプレートが要求しているのにコードが渡していない変数。 */
	unknown: string[];
}

/**
 * 取得した版をコードが差し込めるかを検査する。**型とテストを失ったぶんをここで
 * 取り戻す**のが役目で、どちらかが空でなければ呼び出し側は fallback へ落とす。
 *
 * 2方向を見るのは、mustache がどちらの食い違いも**黙って**畳んでしまうため:
 *
 *  - `missing`: `{{region_context}}` を消されると、グラウンディング無しのまま推論が走る
 *  - `unknown`: 新しい `{{tone}}` を足されると、コードが値を持たないので空文字に畳まれ、
 *    書いた本人の意図した文面にならないまま本番へ出る
 *
 * `unknown` を弾く結果として、**変数を増やす版はコード側が追随するまで効かない**。
 * それが狙いで、効かなかったことは warn ログと `promptSource` から分かる。
 */
export function checkTemplateVariables(
	template: string,
	args: { required: readonly string[]; supplied: Record<string, string> },
): TemplateVariableMismatch {
	const declared = extractTemplateVariables(template);
	const declaredSet = new Set(declared);
	return {
		missing: args.required.filter((name) => !declaredSet.has(name)),
		unknown: declared.filter((name) => !(name in args.supplied)),
	};
}

/**
 * 差し込み後に未解決の `{{…}}` が残っていないか(最後の保険)。
 *
 * 変数の食い違いは `checkTemplateVariables` が先に弾くので、ここに掛かるのは
 * mustache が展開しきれなかった壊れた記法だけ。掛かったらその版は使わない。
 */
export function hasUnresolvedPlaceholders(text: string): boolean {
	return /\{\{[^}]*\}\}/.test(text);
}

/**
 * コードの fallback テンプレートを差し込む。
 *
 * **対象は `MANAGED_PROMPTS` の `template` だけ**で、単純な `{{変数名}}` しか含まない
 * (登録簿の規約)。Langfuse から取れた版は SDK の `compile()`(mustache)で差し込み、
 * Playground / Experiments と同じ意味論に揃える —— 実行時だけ別の展開規則にすると
 * 「Playground では通ったのに本番で違う」が起きる。
 */
export function compileFallbackTemplate(
	template: string,
	variables: Record<string, string>,
): string {
	return template.replace(
		/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
		(match, name: string) => variables[name] ?? match,
	);
}
