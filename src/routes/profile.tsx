import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { getSession } from "#/server/auth";

export const Route = createFileRoute("/profile")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	component: ProfilePage,
});

function ProfilePage() {
	const { data: session, refetch: refetchSession } = authClient.useSession();

	const [name, setName] = useState("");
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [error, setError] = useState("");
	const [successMessage, setSuccessMessage] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (session?.user.name) setName(session.user.name);
	}, [session?.user.name]);

	const { mutate: saveName, isPending: savingName } = useMutation({
		mutationFn: async () => {
			const result = await authClient.updateUser({ name });
			if (result.error)
				throw new Error(result.error.message ?? "Update failed");
		},
		onSuccess: async () => {
			await refetchSession();
			setSuccessMessage("名前を更新しました。");
			setError("");
		},
		onError: (err: Error) => {
			setError(err.message);
			setSuccessMessage("");
		},
	});

	const { mutate: uploadAvatar, isPending: uploadingAvatar } = useMutation({
		mutationFn: async () => {
			if (!selectedFile) return;
			const form = new FormData();
			form.append("avatar", selectedFile);
			const res = await fetch("/api/upload", { method: "POST", body: form });
			if (!res.ok) {
				const body = (await res.json()) as { error?: string };
				throw new Error(body.error ?? "Upload failed");
			}
			const { imageUrl } = (await res.json()) as { imageUrl: string };
			const result = await authClient.updateUser({ image: imageUrl });
			if (result.error)
				throw new Error(result.error.message ?? "Profile update failed");
		},
		onSuccess: async () => {
			await refetchSession();
			if (previewUrl) {
				URL.revokeObjectURL(previewUrl);
				setPreviewUrl(null);
			}
			setSelectedFile(null);
			if (fileInputRef.current) fileInputRef.current.value = "";
			setSuccessMessage("プロフィール画像を更新しました。");
			setError("");
		},
		onError: (err: Error) => {
			setError(err.message);
			setSuccessMessage("");
		},
	});

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0] ?? null;
		if (!file) return;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		setSelectedFile(file);
		setPreviewUrl(URL.createObjectURL(file));
	};

	const currentAvatarUrl = previewUrl ?? session?.user.image ?? null;
	const userInitial = session?.user.name?.charAt(0).toUpperCase() ?? "U";
	const isPending = savingName || uploadingAvatar;

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<h1 className="mb-6 text-2xl font-bold">プロフィール</h1>
			<Card>
				<CardHeader>
					<CardTitle>プロフィール編集</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-6">
					<div className="flex flex-col gap-3">
						<Label>プロフィール画像</Label>
						<div className="flex items-center gap-4">
							{currentAvatarUrl ? (
								<img
									src={currentAvatarUrl}
									alt="アバタープレビュー"
									className="h-16 w-16 rounded-full object-cover border border-border"
								/>
							) : (
								<div className="h-16 w-16 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center border border-border">
									<span className="text-xl font-medium text-neutral-600 dark:text-neutral-400">
										{userInitial}
									</span>
								</div>
							)}
							<div className="flex flex-col gap-2">
								<Input
									ref={fileInputRef}
									type="file"
									accept="image/jpeg,image/png,image/webp,image/gif"
									onChange={handleFileChange}
									className="max-w-xs"
								/>
								<p className="text-xs text-muted-foreground">
									JPEG・PNG・WebP・GIF、最大5MB
								</p>
							</div>
						</div>
						{selectedFile && (
							<Button
								type="button"
								disabled={isPending}
								onClick={() => uploadAvatar()}
								className="self-start"
							>
								{uploadingAvatar ? "アップロード中..." : "画像をアップロード"}
							</Button>
						)}
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="display-name">表示名</Label>
						<Input
							id="display-name"
							type="text"
							placeholder="お名前"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>

					{error && <p className="text-sm text-destructive">{error}</p>}
					{successMessage && (
						<p className="text-sm text-green-600 dark:text-green-400">
							{successMessage}
						</p>
					)}

					<Button
						type="button"
						disabled={isPending || !name.trim()}
						onClick={() => saveName()}
						className="self-start"
					>
						{savingName ? "保存中..." : "名前を保存"}
					</Button>
				</CardContent>
			</Card>
		</main>
	);
}
