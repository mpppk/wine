import { z } from "zod";
import rawCentroids from "./aop-centroids.json";

// aop-centroids.json は scripts/build-aop-centroids.mjs の出力
// (public/data/aop/*.geojson の面積加重セントロイド)。位置関係クイズの
// 南北・東西比較に使う代表点で、aopId → [lng, lat]。
const centroidsSchema = z.record(z.string(), z.tuple([z.number(), z.number()]));

export const AOP_CENTROIDS: Record<string, [number, number]> =
	centroidsSchema.parse(rawCentroids);

/** AOPの代表点 [lng, lat]。GeoJSON未生成のAOPは undefined */
export function getCentroid(aopId: string): [number, number] | undefined {
	return AOP_CENTROIDS[aopId];
}
