import rawAops from "./aops.json";
import type { Aop, AopProducer } from "./types";

// aops.json はキュレーションパイプライン(ワークフロー)の出力。
//
// 以前はこのモジュールの読み込み時に aopArraySchema.parse() で全AOPを深く検証して
// いたが、この検証(regex・enum・superRefine を502件のAOP × 多数フィールドに適用)は
// service.ts 経由で全ページのエントリチャンクに載るため、ブラウザ起動時と Worker の
// 各 isolate コールドスタート(スタートアップCPU上限あり)で毎回走り、ログイン画面や
// トップページを含む初期ロードのクリティカルパスを重くしていた(#32)。
//
// スキーマ検証の目的は品種ID参照切れ等の「壊れたデータ」をデプロイ前に検出することなので、
// ランタイムではなくビルド前のテスト(CI)で担保する(data-integrity.test.ts)。
// ランタイムでは、消費側が AopProducer を前提にしているため producers の正規化
// (文字列 → { name } オブジェクト。旧 producerSchema の transform 相当)だけを行う。
function normalizeProducer(producer: unknown): AopProducer {
	return typeof producer === "string"
		? { name: producer }
		: (producer as AopProducer);
}

export const AOPS: Aop[] = (rawAops as unknown as Aop[]).map((aop) => ({
	...aop,
	producers: (aop.producers as unknown as unknown[]).map(normalizeProducer),
}));
