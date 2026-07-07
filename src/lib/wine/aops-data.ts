import { aopArraySchema } from "./aop-schema";
import rawAops from "./aops.json";
import type { Aop } from "./types";

// aops.json はキュレーションパイプライン(ワークフロー)の出力。読み込み時に
// スキーマ検証することで、品種IDの参照切れ等の壊れたデータをデプロイ前に検出する。
export const AOPS: Aop[] = aopArraySchema.parse(rawAops) as Aop[];
