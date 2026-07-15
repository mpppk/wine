// 生産者に関する簡単な解説と公式サイト。生産者名クリック時の購入リンク
// ダイアログ(AopDetailPanel の ProducerPurchaseDialog)で表示する。
//
// 同じ生産者が複数の畑・村に登場するため、aops.json 側にインラインで持たせると
// 解説・URLが重複する。affiliate.ts の PRODUCER_SEARCH_KEYWORDS と同様、生産者名を
// キーにした共通辞書としてここで一元管理する。
//
// キーは aops.json の producers に現れる表記そのものと一致させること
// (data-integrity テストで参照整合性を検証する)。

export interface ProducerInfo {
	/** 生産者の簡単な解説(日本語・1〜2文) */
	description: string;
	/** 公式サイトのURL。存在する場合のみ。アフィリエイトではない一次情報リンク */
	officialWebsite?: string;
}

/**
 * 生産者名 → 解説・公式サイト。
 *
 * 初期データは、ミシュランガイドが2026年に初めて発表したブルゴーニュ格付け
 * 「MICHELIN Grapes」で最高評価(3グレープ)を獲得した9生産者。解説・公式サイトの
 * 有無はいずれもウェブ調査で確認済み。DRC・ルロワなど公式サイトを持たない造り手は
 * officialWebsite を省略する。
 */
export const PRODUCER_INFO: Record<string, ProducerInfo> = {
	"Domaine de la Romanée-Conti": {
		description:
			"ヴォーヌ・ロマネに本拠を置くドメーヌで、ロマネ・コンティとラ・ターシュを単独所有する。ビオディナミを採用し、グラン・クリュを中心に長命な赤ワインと少量の白を産する。",
		officialWebsite: "https://www.romanee-conti.fr/",
	},
	"Domaine Leroy": {
		description:
			"ヴォーヌ・ロマネに本拠を置くビオディナミ栽培の造り手。1988年に設立され、極めて低い収量による凝縮した赤ワインを中心に、複数のグラン・クリュを産する。",
		officialWebsite: "https://domaine-leroy.fr/",
	},
	"Domaine d'Auvenay": {
		description:
			"ラルー・ビーズ・ルロワが所有するサン・ロマンの微小規模ドメーヌ。ビオディナミ農法により、白・赤の特級を含む小さな区画から極少量のワインを生産する。",
	},
	"Domaine Coche-Dury": {
		description:
			"ムルソーを本拠とする白ワインの造り手。ムルソーの各1級やコルトン・シャルルマーニュを手がけ、還元的な醸造による凝縮感とミネラル感、長期熟成能力で高く評価される。",
	},
	"Domaine Georges Roumier": {
		description:
			"シャンボール・ミュジニーを本拠とするドメーヌで、クリストフ・ルーミエが運営。ボンヌ・マールやミュジニーを擁し、繊細で長期熟成に向く赤で高く評価される。",
		officialWebsite: "https://www.roumier.com/",
	},
	"Domaine Dugat-Py": {
		description:
			"ジュヴレ・シャンベルタンを本拠とする家族経営ドメーヌ。有機・ビオディナミ栽培と古樹から凝縮感のある力強い赤を造り、シャルムやマジ・シャンベルタンなどのグラン・クリュで知られる。",
		officialWebsite: "http://www.dugat-py.com/",
	},
	"Domaine Cécile Tremblay": {
		description:
			"2003年設立、ヴォーヌ・ロマネを拠点とする小規模生産者。相続した古樹の畑を有機・ビオディナミ栽培で手がけ、繊細で芳香高い赤ワインで近年高く評価される。",
		officialWebsite: "https://www.domaine-ceciletremblay.fr/",
	},
	"Domaine Jean-Marc & Thomas Bouley": {
		description:
			"ヴォルネイに本拠を置く家族経営のドメーヌ。ヴォルネイとポマールの赤(ピノ・ノワール)を主体とし、クロ・デ・シェーヌやカイユレなどの1級畑で知られる。",
		officialWebsite: "https://www.jean-marc-bouley.com/",
	},
	"Domaine Hubert Lamy": {
		description:
			"サン・トーバンを本拠とする白ワインの造り手。オリヴィエ・ラミが高密植栽培(オート・ダンシテ)を用い、ミネラル感のある辛口白を生産する。",
		officialWebsite: "https://www.domainehubertlamy.com/",
	},
};

/** 生産者名から解説・公式サイトを引く。未登録なら undefined */
export function getProducerInfo(name: string): ProducerInfo | undefined {
	return PRODUCER_INFO[name];
}
