import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import { isAdminSession } from "#/lib/admin/guard";
import {
	IMPERSONATION_READONLY_MESSAGE,
	isImpersonatedSession,
	isImpersonationWriteBlocked,
	isWriteRequest,
} from "#/lib/admin/impersonation";
import { auth } from "#/lib/auth";
import {
	BadRequestError,
	ForbiddenError,
	HttpError,
	TooManyRequestsError,
	UnauthorizedError,
} from "#/lib/errors";
import { logError, logInfo, logWarn } from "#/lib/logger";
import { withinRateLimit } from "#/lib/rate-limit";

// server function が throw すると既定では HTTP 500 になる。認証切れ(正常系)や
// クライアント入力エラー(4xx相当)まで 5xx に混ざると、Workers のメトリクス上で
// 実際の障害シグナルが希釈され、クライアントもステータスで種別を判別できない。
// そこで認証失敗は 401/403 を明示し、ハンドラ(サービス層)が投げる HttpError も
// この境界で対応するステータスへ写す。
//
// 加えて、HttpError 以外(=想定外の 5xx)はこの1箇所で構造化ログに残す。全 server
// function がこのミドルウェアを通るため、新機能(billing/credit/ai 等)の想定外失敗も
// 呼び出し側に手を入れず userId 付きで Workers Logs から追跡できる(#156)。
async function runWithHttpStatus<T>(
	next: () => Promise<T> | T,
	ctx?: { userId?: string; path?: string },
): Promise<T> {
	try {
		return await next();
	} catch (e) {
		if (e instanceof HttpError) {
			// 想定内の 4xx。ステータスだけ写してログは出さない(障害シグナルを薄めない)。
			setResponseStatus(e.status);
		} else {
			// path が無いと、D1 障害などで複数機能が同時に落ちたときに同一文言の行が
			// 並ぶだけになり、`bun run logs --level error` から障害箇所を切り分けられない
			// (#332)。同ファイルの未認証ログ・書き込みブロックログは既に path を残して
			// いたので、失敗ログだけドリフトしていた。
			logError("server fn failed", {
				userId: ctx?.userId,
				path: ctx?.path,
				err: e,
			});
		}
		throw e;
	}
}

/** ログに載せる server function の識別子。同種のログ(未認証・書き込みブロック)と揃える。 */
function pathOf(request: Request): string {
	return new URL(request.url).pathname;
}

/**
 * なりすまし(impersonation)中の書き込みを拒否する共通ガード(#116)。
 *
 * なりすまし中の書き込みは対象ユーザ本人の実データに落ち、後から本人の操作と切り分け
 * られない。判定自体は `#/lib/admin/impersonation` の純関数に閉じ、server function の
 * 全経路がこの1箇所を通る(唯一の例外は「なりすましを終了する」操作で、これは
 * `impersonationMiddleware` という別のミドルウェアを使うことで構成として除外する)。
 */
function assertNotImpersonatedWrite(
	session: Awaited<ReturnType<typeof auth.api.getSession>>,
	request: Request,
): void {
	if (!isImpersonationWriteBlocked(session, request.method)) return;
	setResponseStatus(403);
	// 管理者の誤操作・UIの取りこぼしを後から追えるよう痕跡を残す(正常系なので warn)。
	logWarn("impersonated write blocked", {
		userId: session?.user.id,
		path: pathOf(request),
	});
	throw new ForbiddenError(IMPERSONATION_READONLY_MESSAGE);
}

/**
 * 書き込みリクエストのスロットル(#397)。
 *
 * **読み取りは絞らない**。1画面が複数の server function を並行に呼ぶため、読み取りまで
 * 数えると通常利用が先に上限へ当たる。#397 の脅威(エントリ・写真・外部fetchの積み上げ)は
 * すべて書き込み側にあるので、書き込みの定義は `isWriteRequest`(なりすましガードと
 * 共有する SSOT)に委ねる。
 *
 * server function の入口はここ1箇所なので、後から足す機能も自動的に通る。
 *
 * **管理ルート(`adminMiddleware`)には掛けない**。一括クレジット補填のような運用操作は
 * 短時間に多くの書き込みを出す正当な用途で、絞ると障害対応の手を縛る。管理者は
 * `isAdminSession` で絞り込まれた信頼済みの主体なので、#397 の脅威モデル
 * (「サインアップは開放されているので1アカウント作れば」)の外にある。
 *
 * `optionalAuthMiddleware` にも掛けていない。現状 GET のみで、未ログインには
 * ユーザ単位のキーが無いため(未認証経路の保護は better-auth 側の
 * `/api/auth/*` レートリミットが担う)。**ここに書き込みを足すときはキーの設計から
 * 考え直すこと**。
 */
async function assertWriteRateLimit(
	userId: string,
	request: Request,
): Promise<void> {
	if (!isWriteRequest(request.method)) return;
	const path = pathOf(request);
	if (await withinRateLimit("write", userId, { userId, path })) return;
	// 拒否のログは withinRateLimit 側で出している(ここで二重に出さない)。
	setResponseStatus(429);
	throw new TooManyRequestsError();
}

export const authMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) {
			setResponseStatus(401);
			// 認証切れは正常系だが、痕跡が皆無だと「クイズの進捗が保存されていない」等の
			// 問い合わせを裏取りする手段が無くなる(#255)。error ではなく warn で残し、
			// 障害シグナル(logError)を薄めずに追跡だけ可能にする。
			logWarn("server fn unauthorized", { path: pathOf(request) });
			throw new UnauthorizedError();
		}
		assertNotImpersonatedWrite(session, request);
		await assertWriteRateLimit(session.user.id, request);
		return runWithHttpStatus(
			() => next({ context: { user: session.user, session: session.session } }),
			{ userId: session.user.id, path: pathOf(request) },
		);
	},
);

/** 管理者(role="admin")限定ミドルウェア。非管理者・BAN中は 403 で拒否する */
export const adminMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		// role==="admin" かつ !banned の単一情報源(ルートの beforeLoad と共有)。
		if (!isAdminSession(session)) {
			setResponseStatus(403);
			throw new ForbiddenError();
		}
		// 管理者へのなりすましは better-auth 側が既定で拒否する(allowImpersonatingAdmins
		// 未設定)ため通常ここは通らないが、管理操作こそ本人の意思で行われるべきなので
		// 多層防御として明示的に塞ぐ。
		assertNotImpersonatedWrite(session, request);
		return runWithHttpStatus(
			() => next({ context: { user: session.user, session: session.session } }),
			{ userId: session.user.id, path: pathOf(request) },
		);
	},
);

/** ログイン任意のミドルウェア。未ログインなら user: null を注入する */
export const optionalAuthMiddleware = createMiddleware({
	type: "function",
}).server(async ({ next }) => {
	const request = getRequest();
	const session = await auth.api.getSession({ headers: request.headers });
	// 現状この経路は GET のみだが、後から書き込みが足されたときに素通りしないよう
	// 他の2つと同じガードを通す(#116)。
	assertNotImpersonatedWrite(session, request);
	// 未ログインでも通すが、ハンドラが入力検証で投げる HttpError(400等)は
	// 適切なステータスへ写す。
	return runWithHttpStatus(
		() => next({ context: { user: session?.user ?? null } }),
		{ userId: session?.user?.id, path: pathOf(request) },
	);
});

/**
 * 「なりすまし中のセッション」限定ミドルウェア(#116)。
 *
 * なりすましの**終了**だけは、なりすまし中(=閲覧専用)のセッションから実行できなければ
 * ならない。`authMiddleware` に例外リストを持たせると経路が増えるたびに緩む余地が
 * できるため、専用のミドルウェアに分けて「書き込みガードを通らない server function は
 * これ1本だけ」という構成上の保証にする。
 */
export const impersonationMiddleware = createMiddleware({
	type: "function",
}).server(async ({ next }) => {
	const request = getRequest();
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		setResponseStatus(401);
		throw new UnauthorizedError();
	}
	if (!isImpersonatedSession(session)) {
		setResponseStatus(400);
		throw new BadRequestError("なりすまし中ではありません。");
	}
	logInfo("impersonation session action", {
		userId: session.user.id,
		path: pathOf(request),
	});
	return runWithHttpStatus(
		() => next({ context: { user: session.user, session: session.session } }),
		{ userId: session.user.id, path: pathOf(request) },
	);
});
