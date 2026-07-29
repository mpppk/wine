import { IMPERSONATION_READONLY_MESSAGE } from "#/lib/admin/impersonation";
import { UNAUTHORIZED_MESSAGE } from "#/lib/errors";

// クイズ解答の「サーバ保存に失敗した」状態の分類。UI に出す文言と導線を決めるためだけの
// 純ロジックで、DB にも cloudflare:workers にも依存しない(#255)。

/**
 * - `unauthorized`: セッション失効・未ログイン。再ログインしない限り以後も保存されない
 * - `readOnly`: 管理者のなりすまし(impersonation)中。仕様どおりの拒否で、通信の問題ではない
 * - `unknown`: 通信断・サーバエラーなど。復帰しうるので再試行の余地がある
 */
export type QuizSaveFailureKind = "unauthorized" | "readOnly" | "unknown";

export interface QuizSaveFailure {
	kind: QuizSaveFailureKind;
	/** 直近の成功以降に連続して失敗した回数。表示の強さを変える材料にする */
	count: number;
}

/**
 * 解答記録の失敗がセッション失効によるものかを判定する。
 *
 * server function がサーバで投げた例外は、クライアントに届く時点で素の `Error` に
 * 平坦化される(クラス名は `Error`、HTTP ステータスは持たない)。実機で確認した形は
 * `Error { name: "Error", message: "Unauthorized" }` で、`UnauthorizedError` の
 * 既定メッセージだけが残る。そのためメッセージ一致で判定し、送出側と同じ定数
 * (`UNAUTHORIZED_MESSAGE`)を参照して食い違いを防ぐ。
 *
 * 将来フレームワークがステータスを保つようになった場合に備え、`status` / `statusCode`
 * が 401 のケースも拾う(先に見る方が確実なため優先する)。
 */
export function classifyQuizSaveFailure(error: unknown): QuizSaveFailureKind {
	if (typeof error === "object" && error !== null) {
		const withStatus = error as { status?: unknown; statusCode?: unknown };
		if (withStatus.status === 401 || withStatus.statusCode === 401) {
			return "unauthorized";
		}
	}
	if (error instanceof Error && error.message === UNAUTHORIZED_MESSAGE) {
		return "unauthorized";
	}
	// なりすまし中の書き込み拒否(#116)。仕様どおりの 403 なので「通信環境を確認して
	// ください」と案内すると誤りになる。unauthorized と同じくメッセージ一致で拾う
	// (server function の例外はクライアント到達時に素の Error へ平坦化される)。
	if (
		error instanceof Error &&
		error.message === IMPERSONATION_READONLY_MESSAGE
	) {
		return "readOnly";
	}
	return "unknown";
}

/** 失敗を1件積む。種別が変わったら新しい種別で数え直す(直近の原因を表示するため)。 */
export function addSaveFailure(
	prev: QuizSaveFailure | null,
	error: unknown,
): QuizSaveFailure {
	const kind = classifyQuizSaveFailure(error);
	if (prev && prev.kind === kind) return { kind, count: prev.count + 1 };
	return { kind, count: 1 };
}
