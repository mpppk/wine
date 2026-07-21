# AOP境界データ（GeoJSON）の生成

`public/data/aop/*.geojson`（AOP境界・地方/地区輪郭）と `src/lib/wine/aop-centroids.json`（代表点）は、公式オープンデータから `scripts/build-*.mjs` で生成する。**生成物はコミット済み**であり、再実行が必要なのはデータ更新時のみ。

AOPのメタデータ（土壌・品種・生産者）は `src/lib/wine/aops.json` にあり、`src/lib/wine/aop-schema.ts` のスキーマで読み込み時に検証される。GeoJSON との結合キー（`idApp`）の帯規約や整合性テストなどのモデリングルールは [docs/architecture.md](./architecture.md) を参照。

## コマンド一覧

| コマンド | 生成物 | 備考 |
|---|---|---|
| `bun run build:geodata` | フランス地域の `<region>.geojson` | node 実行 |
| `bun run build:geodata:italy` | イタリア（ピエモンテ/トスカーナ）の `<region>.geojson` | node 実行 |
| `bun run build:centroids` | `src/lib/wine/aop-centroids.json` | コミット済み GeoJSON のみを入力とする |
| `bun run build:boundaries` | `<region>-boundaries.geojson`（地方・地区輪郭） | bun 実行（`regions.ts` を直接 import するため） |

外部データは `.cache/` にキャッシュされる。

## フランス

```bash
bun run build:geodata
```

- 村名/グラン・クリュ: INAO「Délimitation parcellaire des AOC viticoles」（data.gouv.fr、約270MBのShapefileを自動ダウンロードして `.cache/` にキャッシュ）
- 広域AOC: INAO「Aires géographiques des AOC/AOP」CSV × geo.api.gouv.fr のコミューン輪郭
- コミューン結合・シャトー座標などのキュレーション表（`COMMUNES_BY_AOP_ID` / `WINERY_COORDS_BY_AOP_ID` 等）は `scripts/build-aop-geodata.mjs` 内で管理する
- 実行後に表示される bounds を `src/lib/wine/regions.ts` に反映する

## イタリア（ピエモンテ/トスカーナ）

イタリアには公式の区画GISが存在しないため、別データソース・別スクリプトで生成する:

```bash
bun run build:geodata:italy            # figshareからgpkgをDL(キャッシュ)
bun run build:geodata:italy -- --source /path/to/EU_PDO.gpkg   # ローカル指定も可
```

- 出典: Candiago, S. et al. "A geospatial inventory of regulatory information for wine
  protected designations of origin in Europe." *Sci Data* 9, 394 (2022).
  figshare `doi:10.6084/m9.figshare.19312094`（EU_PDO.gpkg, ライセンス **CC0**）
- 各PDOをコミューン単位で集約した境界（フランスの区画単位より粗い概略値）
- `PDOid` と `aops.json` の対応は `scripts/build-italy-geodata.mjs` の `REGION_CONFIGS` の pdo 対応表が真実の源（追記のみ。既存行の `idApp` は変えない）
- 実行後に表示される bounds を `src/lib/wine/regions.ts` の該当地域に反映する

## 再生成時の注意

- GeoJSON を再生成したら**必ず `bun run build:centroids` も実行**する（`centroids.test.ts` が乖離を検出する）。地方・地区輪郭が変わる場合は `bun run build:boundaries` も実行する。
- GeoJSON のフィーチャ順は描画順（後ろ=前面）とクリック解決を兼ねる契約なので、並びを変えない。
- 件数スナップショットテスト（`src/lib/wine/data-integrity.test.ts`）がデータ追加で落ちるのは想定どおりで、期待値を意図的に更新する。
