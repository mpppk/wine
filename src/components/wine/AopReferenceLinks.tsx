import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	CheckIcon,
	ExternalLinkIcon,
	LinkIcon,
	LogInIcon,
	PencilIcon,
	PlusIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { ReferenceLinkEntry } from "#/lib/services/reference-link-service";
import {
	createReferenceLink,
	deleteReferenceLink,
	listReferenceLinks,
	updateReferenceLink,
} from "#/server/reference-link";

// 情報パネル(AopDetailPanel)内の「参考リンク」セクション。ユーザが村・畑・地方・
// シャトーごとに自分専用のリンクを追加・編集・削除できる。非ログイン時はログイン導線
// のみ表示。データ取得/更新(query/mutation)はこのコンポーネントに閉じ込め、パネル
// 本体は表示専用のまま保つ。embed(公開iframe)からはこのスロット自体を渡さない。

const SECTION_HEADING = "参考リンク";

function referenceLinksKey(aopId: string) {
	return ["referenceLinks", aopId] as const;
}

function SectionShell({
	children,
	headerAction,
}: {
	children: React.ReactNode;
	/** 見出し右端に置く操作（追加ボタン等）。未指定なら何も置かない */
	headerAction?: React.ReactNode;
}) {
	return (
		<section>
			<h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<LinkIcon className="size-3.5" aria-hidden />
				{SECTION_HEADING}
				{headerAction && <span className="ml-auto">{headerAction}</span>}
			</h3>
			{children}
		</section>
	);
}

export function AopReferenceLinks({
	aopId,
	isAuthenticated,
}: {
	aopId: string;
	isAuthenticated: boolean;
}) {
	if (!isAuthenticated) {
		return (
			<SectionShell>
				<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<span>ログインすると参考リンクを追加できます</span>
					<Button asChild size="sm" variant="secondary">
						<Link to="/login">
							<LogInIcon className="size-3.5" aria-hidden />
							ログイン
						</Link>
					</Button>
				</div>
			</SectionShell>
		);
	}
	return <AuthedReferenceLinks aopId={aopId} />;
}

function AuthedReferenceLinks({ aopId }: { aopId: string }) {
	const queryClient = useQueryClient();
	const queryKey = referenceLinksKey(aopId);
	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const {
		data: links,
		isPending,
		isError,
	} = useQuery({
		queryKey,
		queryFn: () => listReferenceLinks({ data: { aopId } }),
	});

	// インライン編集中のリンクid(null で編集なし)
	const [editingId, setEditingId] = useState<string | null>(null);
	// 追加フォームの開閉。閉じると入力欄はアンマウントされ、次に開くと空で始まる
	const [addOpen, setAddOpen] = useState(false);

	const createMutation = useMutation({
		mutationFn: (input: { url: string; title?: string }) =>
			createReferenceLink({
				data: { aopId, url: input.url, title: input.title },
			}),
		onSuccess: async () => {
			setAddOpen(false);
			await invalidate();
		},
	});

	const updateMutation = useMutation({
		mutationFn: (input: { id: string; url: string; title: string | null }) =>
			updateReferenceLink({
				data: { id: input.id, url: input.url, title: input.title },
			}),
		onSuccess: async () => {
			setEditingId(null);
			await invalidate();
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteReferenceLink({ data: { id } }),
		onSuccess: invalidate,
	});

	// 見出し右端の控えめな追加ボタン(プラスアイコンのみ)。押すと入力欄を開閉する
	const addButton = (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className="-my-1 size-6 text-muted-foreground hover:text-foreground"
			aria-label="参考リンクを追加"
			aria-expanded={addOpen}
			onClick={() => setAddOpen((o) => !o)}
		>
			<PlusIcon className="size-4" />
		</Button>
	);

	return (
		<SectionShell headerAction={addButton}>
			<div className="flex flex-col gap-2">
				{isError ? (
					<p className="text-sm text-destructive">
						参考リンクの取得に失敗しました
					</p>
				) : isPending ? (
					<p className="text-sm text-muted-foreground">読み込み中...</p>
				) : links.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						まだ参考リンクがありません。
					</p>
				) : (
					<ul className="flex flex-col gap-1.5">
						{links.map((link) =>
							editingId === link.id ? (
								<li key={link.id}>
									<LinkEditor
										initialUrl={link.url}
										initialTitle={link.title ?? ""}
										submitLabel="保存"
										pending={updateMutation.isPending}
										error={updateMutation.error?.message}
										onCancel={() => setEditingId(null)}
										onSubmit={({ url, title }) =>
											updateMutation.mutate({
												id: link.id,
												url,
												// 空欄はクリア→次の解決でページから再取得
												title: title === "" ? null : title,
											})
										}
									/>
								</li>
							) : (
								<li key={link.id}>
									<LinkRow
										link={link}
										onEdit={() => setEditingId(link.id)}
										onDelete={() => deleteMutation.mutate(link.id)}
										deleting={
											deleteMutation.isPending &&
											deleteMutation.variables === link.id
										}
									/>
								</li>
							),
						)}
					</ul>
				)}

				{addOpen && (
					<LinkEditor
						initialUrl=""
						initialTitle=""
						submitLabel="追加"
						pending={createMutation.isPending}
						error={createMutation.error?.message}
						onCancel={() => setAddOpen(false)}
						onSubmit={({ url, title }) =>
							createMutation.mutate({
								url,
								title: title === "" ? undefined : title,
							})
						}
					/>
				)}
			</div>
		</SectionShell>
	);
}

// 1件のリンク行(表示状態)。タイトルがあればタイトル、無ければURLを表示する。
function LinkRow({
	link,
	onEdit,
	onDelete,
	deleting,
}: {
	link: ReferenceLinkEntry;
	onEdit: () => void;
	onDelete: () => void;
	deleting: boolean;
}) {
	return (
		<div className="flex items-center gap-1">
			<a
				href={link.url}
				target="_blank"
				rel="noopener noreferrer nofollow"
				title={link.url}
				className="flex min-w-0 flex-1 items-center gap-1 text-sm underline decoration-dotted underline-offset-2 hover:text-foreground"
			>
				<span className="truncate">{link.title ?? link.url}</span>
				<ExternalLinkIcon className="size-3 shrink-0 opacity-60" aria-hidden />
			</a>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
				aria-label="リンクを編集"
				onClick={onEdit}
			>
				<PencilIcon className="size-3.5" />
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
				aria-label="リンクを削除"
				onClick={onDelete}
				disabled={deleting}
			>
				<Trash2Icon className="size-3.5" />
			</Button>
		</div>
	);
}

// URL(必須)+ タイトル(任意)の入力フォーム。追加・編集で共用する。
function LinkEditor({
	initialUrl,
	initialTitle,
	submitLabel,
	pending,
	error,
	onSubmit,
	onCancel,
}: {
	initialUrl: string;
	initialTitle: string;
	submitLabel: string;
	pending: boolean;
	error?: string;
	onSubmit: (v: { url: string; title: string }) => void;
	onCancel?: () => void;
}) {
	const [url, setUrl] = useState(initialUrl);
	const [title, setTitle] = useState(initialTitle);
	const canSubmit = url.trim() !== "" && !pending;

	return (
		<form
			className="flex flex-col gap-1.5 rounded-md border border-border p-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!canSubmit) return;
				onSubmit({ url: url.trim(), title: title.trim() });
			}}
		>
			<Input
				type="url"
				inputMode="url"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				placeholder="https://example.com/..."
				maxLength={2048}
				required
				aria-label="URL"
				className="h-8"
			/>
			<Input
				type="text"
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="タイトル(未入力ならページから自動取得)"
				maxLength={200}
				aria-label="タイトル"
				className="h-8"
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex items-center gap-1.5">
				<Button type="submit" size="sm" className="h-7" disabled={!canSubmit}>
					<CheckIcon className="size-3.5" aria-hidden />
					{pending ? "保存中..." : submitLabel}
				</Button>
				{onCancel && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7"
						onClick={onCancel}
						disabled={pending}
					>
						<XIcon className="size-3.5" aria-hidden />
						キャンセル
					</Button>
				)}
			</div>
		</form>
	);
}
