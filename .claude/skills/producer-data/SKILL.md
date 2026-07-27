---
name: producer-data
description: 生産者・格付け・受賞データを aops.json / producer-info.ts / affiliate.ts に追加・修正するときの出典確認チェックリスト。ワイン産地の生産者拡充、格付けタグの追加、受賞歴の登録時に使う。
---

# 生産者・格付け・受賞データの追加チェックリスト

`aops.json` の `producers` / `tags`、`producer-info.ts` の `awards`、`affiliate.ts` の
`PRODUCER_SEARCH_KEYWORDS` を触るときの手順。**このアプリは学習用なので、誤ったデータは
利用者に誤った事実を教えることになる**（`aop-classification` クイズは格付けタグを出題に使う）。

#203 の一連のPR（#209/#210/#214/#215/#216/#218/#219/#220）で、**確認して初めて分かった
誤りが繰り返し出た**。以下はその実例から作った関門。

## 1. 件数の記述を信用せず、列挙されたリストを数える

「N件」と書いてある本文と、実際に列挙されている名前の数は**しばしば食い違う**。

| 事例 | 記述 | 実際 |
|---|---|---|
| サンテミリオン Grands Crus Classés（#219） | 66 / 62 | **71** |
| トレ・ビッキエーリ2026 トスカーナ（#215） | 94 | **93** |

必ずリストをファイルに落として `wc -l` で数える。要約モデルの出す件数も当てにしない。

## 2. 版（年次）を確認する。Wikipedia は古い版のことがある

| 事例 | 危なかった点 |
|---|---|
| クリュ・ブルジョワ Exceptionnel（#220） | Wikipedia は**2020年版**。2025年版とは**14件中8件が別物** |

「最新版はどれか」を先に確定し、**授与元・格付け機関の公式ページ**で突き合わせる。
公式PDFしか無い場合は下記「PDFを読む」を使う。

## 3. 現存しない銘柄・離脱した造り手を載せない

格付けリストは制定時のもので、**現在も存在するとは限らない**。

| 事例 | 状況 |
|---|---|
| `Château La Gaffelière`（#216） | 2022年格付けから**離脱**。タグが付いたままだった |
| `Château La Tour Haut-Brion`（#218） | **2004年が最終ヴィンテージ**。La Mission のセカンドに吸収 |
| `Château Laville Haut-Brion`（#218） | **2008年が最終**。La Mission Haut-Brion Blanc に改名 |

造られていないワインに購入リンクを出すことになるため載せない。**除外した件数と理由を
PR本文とテストのコメントに残す**（後から「格付け16件のうち13件しか無い」と判断して
足し戻されないように）。

## 4. 件数スナップショットだけでは中身の取り違えを検出できない

`La Gaffelière` / `La Mondotte` の取り違えは**件数12件で合っていた**ため、既存の件数
テストを素通りした。格付けを足すときは**顔ぶれ（名前の配列）を固定するテスト**を書く。

`data-integrity.test.ts` の実例:

- `サンテミリオン第1特別級は公式の顔ぶれと一致する`
- `グラーヴ格付けは現存する13件と一致する`
- `クリュ・ブルジョワ Exceptionnel 2025 が AOC ごとに正しく入っている`

## 5. 権利上の線引き

`docs/architecture.md`「ガイド由来情報の取り扱い」が単一情報源。要点だけ:

- **出せる**: 個々の受賞という事実（授与元・受賞名・階級・年・対象ワイン）を**出典URL付き**で
- **出せない**: ガイドの掲載リストを網羅的に転記する／評価文・テイスティングコメントを翻訳・要約する
- 解説文は公式サイト等の一次情報から自分で書く

## 6. 置き場所の使い分け

| データ | 置き場所 | 理由 |
|---|---|---|
| 公的格付けを持つシャトー | `aops.json` の `winery` + `tags` | 地図に点として出す |
| 格付けを持たない著名生産者 | 各AOPの `producers` | #209 の規約 |
| サンテミリオン GCC のような大量の同一ラベル | `producers`（`winery` にしない） | `aop-classification` クイズが単一ラベル70件超に偏る |
| 受賞・格付けの事実 | `producer-info.ts` の `awards` | `sources` は #214 で廃止済み |
| カタカナ検索語 | `affiliate.ts` の `PRODUCER_SEARCH_KEYWORDS` | 未登録だとラテン文字のまま楽天を検索する |

**検索キーワードは追加分と同時に入れる**。同一AOP内で登録の有無が混在すると後から揃えにくい（#211）。

## 7. 編集の技術メモ

### `aops.json` / `aop-centroids.json` は JSON 再ダンプしない

配列のインライン/展開の判断が biome と一致せず、**無関係な既存行に大量の差分が出る**。
対象箇所だけ文字列置換で編集し、最後に整形する。

```bash
bunx biome format --write src/lib/wine/aops.json
```

### winery を足す/消すと geojson と重心も要る

`data-integrity.test.ts` の `features.length === regionAops.length` が効くため、
`public/data/aop/<region>.geojson` と `src/lib/wine/aop-centroids.json` の更新が必須。

```bash
bun run build:geodata -- --region bordeaux && bun run build:centroids
```

**`build:geodata` は INAO の aires CSV が 503 を返して落ちることがある**（外部要因）。
その場合は geojson へ Point フィーチャを直接追記するフォールバックに切り替え、
`build:centroids` だけ流す。フィーチャの形は既存 winery と同じ（`rank: 3`・`bbox` 付き）。
**フォールバックを使ったことは PR 本文に明記する。**

### 座標の取り方（適当な値を置かない）

1. **OSM Nominatim** — `https://nominatim.openstreetmap.org/search?q=<名前>, <コミューン>&format=json`
   （`User-Agent` 必須。1req/秒程度に抑える）
2. ヒットしなければ **Overpass** で範囲を絞って名前検索（畑区画が登録されていることがある）
3. それでも無ければ**公式サイトの住所**をジオコーディングする（精度が街路レベルになる旨をコメントに残す）

取得後は**想定する産地の緯度経度範囲に収まるか**を必ず検証する。既知の隣接シャトーとの
距離が実際の位置関係と合うかも確認できる（例: La Mission Haut-Brion と Haut-Brion は 0.47km）。

### PDF を読む

`pdftotext` は `apt` が 404 で入らない。`pypdf`/`pdfminer` は `cryptography` の rust
バインディング破損でインポートに失敗する。次で復旧する。

```bash
pip install --force-reinstall cryptography
pip install pdfminer.six
python3 -c "from pdfminer.high_level import extract_text; print(extract_text('file.pdf'))"
```

`WebFetch` に PDF の URL を渡すとバイナリのままローカルに保存されるので、そのパスを使う。

## 8. 実機確認

`producers` の追加は geodata を伴わないが、**プレビューで目視する**。

- 12件を超えると #209 の折りたたみが効く（「ほかN件を表示」）。展開して件数を数える
- 購入リンクの `href` をデコードしてカタカナ検索語になっているか見る
- `producers` は格付けバッジを持たない（バッジは `winery` の `tags` から出る）
- **旧版のデータが残っていないこと**も確認する（例: クリュ・ブルジョワ2020年版の面々が出ない）
