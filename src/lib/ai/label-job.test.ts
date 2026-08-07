import { describe, expect, it } from "vitest";
import {
	isTerminalLabelJobStatus,
	LABEL_JOB_QUEUE_STALE_MS,
	LABEL_JOB_STALE_MS,
	labelJobMessageSchema,
} from "./label-job";

describe("labelJobMessageSchema", () => {
	it("jobId だけを載せたメッセージを受け取る", () => {
		expect(labelJobMessageSchema.parse({ jobId: "abc" })).toEqual({
			jobId: "abc",
		});
	});

	it("想定外の形は弾く(コンシューマが捨てる判断の根拠)", () => {
		// キューは at-least-once で、**以前のデプロイが積んだ形**も届きうる。
		// 形を確かめずに使うと、コンシューマが undefined を jobId として D1 を引く。
		for (const body of [null, "abc", {}, { jobId: "" }, { jobId: 1 }]) {
			expect(labelJobMessageSchema.safeParse(body).success).toBe(false);
		}
	});
});

describe("isTerminalLabelJobStatus", () => {
	it("succeeded / failed だけが終端(= UI がポーリングを止めてよい)", () => {
		expect(isTerminalLabelJobStatus("queued")).toBe(false);
		expect(isTerminalLabelJobStatus("running")).toBe(false);
		expect(isTerminalLabelJobStatus("succeeded")).toBe(true);
		expect(isTerminalLabelJobStatus("failed")).toBe(true);
	});
});

describe("stale のしきい値", () => {
	it("queued のほうが running より長い", () => {
		// queued はキューの配信・リトライを待っており、running は推論そのものを待っている。
		// 逆転すると、配信が少し遅れただけのジョブを実行前に失敗させることになる。
		expect(LABEL_JOB_QUEUE_STALE_MS).toBeGreaterThan(LABEL_JOB_STALE_MS);
	});
});
