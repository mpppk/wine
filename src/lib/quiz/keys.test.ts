import { describe, expect, it } from "vitest";
import {
	buildColorsKey,
	buildLocationKey,
	buildOddOneOutKey,
	buildVarietyKey,
	parseKey,
} from "./keys";

describe("問題キーのbuild/parse", () => {
	it("各形式のキーが往復できる", () => {
		expect(parseKey(buildColorsKey("gevrey-chambertin"))).toEqual({
			quizType: "colors",
			aopId: "gevrey-chambertin",
		});
		expect(parseKey(buildOddOneOutKey("color", "white", "morgon"))).toEqual({
			quizType: "odd-one-out",
			axis: "color",
			axisValue: "white",
			aopId: "morgon",
		});
		expect(parseKey(buildVarietyKey("gamay", "morgon"))).toEqual({
			quizType: "variety",
			varietyId: "gamay",
			aopId: "morgon",
		});
		expect(
			parseKey(buildLocationKey("north", "cote-de-nuits", "gevrey-chambertin")),
		).toEqual({
			quizType: "location",
			direction: "north",
			subregionId: "cote-de-nuits",
			aopId: "gevrey-chambertin",
		});
	});

	it("不正なキーは null", () => {
		expect(parseKey("")).toBeNull();
		expect(parseKey("unknown:foo")).toBeNull();
		expect(parseKey("colors")).toBeNull();
		expect(parseKey("colors:a:b")).toBeNull();
		expect(parseKey("odd-one-out:bogus-axis:white:morgon")).toBeNull();
		expect(parseKey("location:northwest:cote-de-nuits:fixin")).toBeNull();
		expect(parseKey("variety:gamay")).toBeNull();
		expect(parseKey("colors:UPPER_CASE")).toBeNull();
		expect(parseKey("colors:gevrey chambertin")).toBeNull();
	});
});
