# AOP境界データ（GeoJSON）の生成

`public/data/aop/*.geojson`（AOP境界・地方/地区輪郭）と `src/lib/wine/aop-centroids.json`（代表点）は、公式オープンデータから `scripts/build-*.mjs` で生成する。**生成物はコミット済み**であり、再実行が必要なのはデータ更新時のみ。

AOPのメタデータ（土壌・品種・生産者）は `src/lib/wine/aops.json` にあり、`src/lib/wine/aop-schema.ts` のスキーマで読み込み時に検証される。GeoJSON との結合キー（`idApp`）の帯規約や整合性テストなどのモデリングルールは [docs/architecture.md](./architecture.md) を参照。

## コマンド一覧

| コマンド | 生成物 | 備考 |
|---|---|---|
| `bun run build:geodata` | フランス地域の `<region>.geojson` | node 実行 |
| `bun run build:geodata:eu` | EU PDO 由来（イタリア・スペイン・ポルトガル・ドイツ・オーストリア）の `<region>.geojson` | node 実行 |
| `bun run build:centroids` | `src/lib/wine/aop-centroids.json` | コミット済み GeoJSON のみを入力とする |
| `bun run build:boundaries` | `<region>-boundaries.geojson`（地方・地区輪郭） | bun 実行（`regions.ts` を直接 import するため） |

外部データは `.cache/` にキャッシュされる。

## フランス

```bash
bun run build:geodata
```

- 村名/グラン・クリュ: INAO「Délimitation parcellaire des AOC viticoles」（data.gouv.fr、約270MBのShapefileを自動ダウンロードして `.cache/` にキャッシュ）
- **`PARCEL_ZIP_URL` / `AIRES_CSV_URL` は版ごとに採番された静的URLをピン留めしており、data.gouv.fr が更新すると旧URLは404になる**（区画経路が丸ごと落ちる）。`https://www.data.gouv.fr/api/1/datasets/delimitation-parcellaire-des-aoc-viticoles-de-linao/` の `resources` から最新URLを引いて差し替える
- 広域AOC: INAO「Aires géographiques des AOC/AOP」CSV × geo.api.gouv.fr のコミューン輪郭
- コミューン結合・シャトー座標などのキュレーション表（`COMMUNES_BY_AOP_ID` / `WINERY_COORDS_BY_AOP_ID` 等）は `scripts/build-aop-geodata.mjs` 内で管理する
- 広域（`kind: "regional"`）のAOCは `AIRES_CSV_NAME_BY_APP` に「aires CSV 上の名称 → `aops.json` の `name`」を足さないと `no aire géographique for …` で落ちる。区画数が少なく肥大化しないものは `PARCEL_REGIONAL_AOP_IDS` に入れて区画経路へ回す
- 実行後に表示される bounds を `src/lib/wine/regions.ts` に反映する

## イタリア・スペイン・ポルトガル・ドイツ・オーストリア（EU PDO 由来）

イタリア（ピエモンテ/トスカーナ/ヴェネト）・スペイン（リオハ/エブロ川流域）・ポルトガル（本土）・ドイツ・オーストリアには公式の区画GISが存在しないため、別データソース・別スクリプトで生成する:

```bash
bun run build:geodata:eu                       # figshareからgpkgをDL(キャッシュ)
bun run build:geodata:eu -- --region rioja     # 特定地域のみ
bun run build:geodata:eu -- --source /path/to/EU_PDO.gpkg   # ローカル指定も可
```

- 出典: Candiago, S. et al. "A geospatial inventory of regulatory information for wine
  protected designations of origin in Europe." *Sci Data* 9, 394 (2022).
  figshare `doi:10.6084/m9.figshare.19312094`（EU_PDO.gpkg, ライセンス **CC0**）
- 各PDOをコミューン（自治体）単位で集約した境界（フランスの区画単位より粗い概略値）
- `PDOid` と `aops.json` の対応は `scripts/build-eu-geodata.mjs` の `REGION_CONFIGS` の pdo 対応表が真実の源（追記のみ。既存行の `idApp` は変えない）
- 対応表を作るときは EU 公式登録簿 eAmbrosia の `fileNumber` と突き合わせる。全登録の一覧は
  `https://webgate.ec.europa.eu/eambrosia-api/api/v1/geographical-indications` が JSON で返す
  （`productType: "WINE"` / `countries: ["ES"]` などで絞り込む）
- ポルトガルは各DOPの `caderno de especificações`（IVV が PDF で公開）が許可品種・土壌・区域の一次情報。
  eAmbrosia の `fileNumber` と合わせて `REGION_CONFIGS` の対応表を作る
- データセットは2021年時点の登録が対象。以後に登録された呼称（スペインの Bolandin 等）は
  収録されていないため、`gpkg に … のジオメトリが無い` で落ちる
- `clipBbox`（地域全体）で落としきれない同名コミューン由来の飛び地は、呼称ごとの
  `pdoClipBbox`（aopId → bbox）で落とす。ドイツのように地域bboxが国全体に及ぶと州境界で
  切れないため。**実在する飛び地（ザクセンのオストリッツ＝ドイツ最東端の畑など）を
  巻き込まないよう、根拠を確認してから足すこと**
- ヴェネトは州をまたぐ呼称の扱いに注意する。プロセッコ DOC はヴェネト5県＋フリウリ4県に
  及ぶため `clipBbox` の東端をトリエステ（約13.9°E）まで取る。**`clipBbox` は同名コミューン
  由来の飛び地を落とすためのもので、法定地域そのものを切り詰める用途ではない**（東端を
  州境で切ると、プロセッコのフリウリ側が地図から消える）。生成後は各フィーチャの `bbox` を
  一覧して、法定地域と合わない塊が無いかを確認する
- ドイツは13の指定栽培地域（アンバウゲビート）に加え、単一畑そのものが g.U. として
  登録された6件（ウーレンの3区画・モンツィンガー・ニーダーベルク・ヴュルツブルガー・
  シュタイン・ベルク・ビュルクシュタッター・ベルク）を収録する。データセットの粒度は
  コミューン単位なので、単一畑 g.U. のポリゴンは**その畑がある自治体の輪郭**であり、
  畑そのものの区画ではない（ウーレンの2区画は同じヴィニンゲンの輪郭になる）
- オーストリアは15の DAC と、州名そのものを名乗る広域 Weinbaugebiet 4件
  （ニーダーエスターライヒ / ブルゲンラント / シュタイヤーマルク / ウィーン）を収録する。
  法定地域の定義は **Weingesetz 2009 §21(3)**（RIS の消費者向け API
  `https://data.bka.gv.at/ris/api/v2.6/Bundesrecht?...&Applikation=BrKons` で引ける）が
  政治郡・市町村の一覧で与えるので、生成後の各フィーチャの bbox はこれと突合する。
  **ヴァーグラムがウィーン北縁に持つ飛び地（ゲラスドルフ・バイ・ウィーン）は法定地域**
  なので `pdoClipBbox` で落とさない。逆に「シュタイヤーマルク」は法定地域が8つの政治郡
  なのに対しデータセットは州全域を返すため、地図は法定地域より広く塗られる
  （AOPの解説文にその旨を書いてある）
- 2020〜2021年に登録された Rosalia / Ruster Ausbruch / Wiener Gemischter Satz の3 DAC は
  データセットに無いため収録していない（ピエモンテの Canelli と同じ）
- 実行後に表示される bounds を `src/lib/wine/regions.ts` の該当地域に反映する

## 再生成時の注意

- GeoJSON を再生成したら**必ず `bun run build:centroids` も実行**する（`centroids.test.ts` が乖離を検出する）。地方・地区輪郭が変わる場合は `bun run build:boundaries` も実行する。
- GeoJSON のフィーチャ順は描画順（後ろ=前面）とクリック解決を兼ねる契約なので、並びを変えない。
- 件数スナップショットテスト（`src/lib/wine/data-integrity.test.ts`）がデータ追加で落ちるのは想定どおりで、期待値を意図的に更新する。
