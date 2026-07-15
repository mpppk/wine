import { createServerFn } from "@tanstack/react-start";
import {
	createReferenceLinkInput,
	deleteReferenceLinkInput,
	listReferenceLinksInput,
	updateReferenceLinkInput,
} from "#/lib/reference-link/schema";
import * as referenceLinkService from "#/lib/services/reference-link-service";
import { authMiddleware } from "./middleware";

// 参考リンク(村・畑・地方・シャトーごと)のRPC。全て非公開のユーザ固有データなので
// 認証必須。userId はクライアントを信用せず context.user.id を使う。

export const listReferenceLinks = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(listReferenceLinksInput)
	.handler(({ data, context }) =>
		referenceLinkService.listReferenceLinks(context.user.id, data.aopId),
	);

export const createReferenceLink = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(createReferenceLinkInput)
	.handler(({ data, context }) =>
		referenceLinkService.createReferenceLink(context.user.id, data),
	);

export const updateReferenceLink = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(updateReferenceLinkInput)
	.handler(({ data, context }) =>
		referenceLinkService.updateReferenceLink(context.user.id, data),
	);

export const deleteReferenceLink = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(deleteReferenceLinkInput)
	.handler(({ data, context }) =>
		referenceLinkService.deleteReferenceLink(context.user.id, data.id),
	);
