import { useCallback, useEffect, useState } from "react";

import { api, describeError, type ShareLinkDto } from "../lib/api";

/** Modal Share dialog: toggle download permission, expiry, copy URL, list & revoke active shares. */
export function ShareDialog({
	imageId,
	open,
	onClose,
}: {
	imageId: string;
	open: boolean;
	onClose: () => void;
}) {
	const [allowDownload, setAllowDownload] = useState(true);
	const [expiresHours, setExpiresHours] = useState<string>("");
	const [links, setLinks] = useState<ShareLinkDto[]>([]);
	const [loading, setLoading] = useState(false);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadShares = useCallback(async () => {
		setLoading(true);
		try {
			const res = await api.shares(imageId);
			setLinks(res.shares);
			setError(null);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setLoading(false);
		}
	}, [imageId]);

	useEffect(() => {
		if (!open) return;
		void loadShares();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, loadShares, onClose]);

	if (!open) return null;

	async function createLink() {
		setError(null);
		try {
			const hrs = expiresHours ? Number(expiresHours) : undefined;
			const res = await api.share(imageId, allowDownload, hrs);
			const full = `${location.origin}${res.url}`;
			await navigator.clipboard?.writeText(full).catch(() => {});
			setCopiedId(res.share.id);
			setTimeout(() => setCopiedId(null), 2000);
			await loadShares();
		} catch (err) {
			setError(describeError(err));
		}
	}

	async function revoke(id: string) {
		try {
			await api.revokeShare(id);
			setLinks((list) => list.filter((l) => l.id !== id));
		} catch (err) {
			setError(describeError(err));
		}
	}

	async function copy(link: ShareLinkDto) {
		const full = `${location.origin}/s/${link.token}`;
		await navigator.clipboard?.writeText(full).catch(() => {});
		setCopiedId(link.id);
		setTimeout(() => setCopiedId(null), 2000);
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs"
			onClick={onClose}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Share photo"
				onClick={(e) => e.stopPropagation()}
				className="ed-panel w-full max-w-md rounded-2xl border ed-hairline p-5 text-sm shadow-2xl"
			>
				<div className="flex items-center justify-between">
					<h2 className="text-base font-semibold">Share photo</h2>
					<button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground">
						×
					</button>
				</div>

				<div className="mt-4 space-y-3 rounded-xl border ed-hairline bg-secondary/35 p-3 text-xs">
					<label className="flex cursor-pointer items-center justify-between">
						<span>Allow full-resolution download</span>
						<input
							type="checkbox"
							checked={allowDownload}
							onChange={(e) => setAllowDownload(e.target.checked)}
							className="accent-indigo-400"
						/>
					</label>
					<label className="flex items-center justify-between gap-2">
						<span>Expires in</span>
						<select
							value={expiresHours}
							onChange={(e) => setExpiresHours(e.target.value)}
							className="rounded-lg border ed-hairline bg-card px-2 py-1"
						>
							<option value="">Never</option>
							<option value="24">24 hours</option>
							<option value="168">7 days</option>
							<option value="720">30 days</option>
						</select>
					</label>
					<button
						type="button"
						onClick={() => void createLink()}
						className="w-full rounded-full bg-foreground py-1.5 font-medium text-background transition hover:opacity-85"
					>
						Create & copy link
					</button>
				</div>

				{error && (
					<p role="alert" className="mt-3 text-xs text-red-300">
						{error}
					</p>
				)}

				<div className="mt-4">
					<p className="mb-2 text-xs font-medium text-muted-foreground">Active share links</p>
					{loading && links.length === 0 ? (
						<p className="text-xs text-muted-foreground">Loading…</p>
					) : links.length === 0 ? (
						<p className="text-xs text-muted-foreground">No active links yet.</p>
					) : (
						<ul className="max-h-48 space-y-2 overflow-y-auto text-xs">
							{links.map((link) => (
								<li key={link.id} className="flex items-center justify-between gap-2 rounded-lg border ed-hairline px-2.5 py-2">
									<div className="min-w-0">
										<p className="truncate font-mono text-[11px]">/s/{link.token.slice(0, 12)}…</p>
										<p className="text-[10px] text-muted-foreground">
											{link.allowDownload ? "Download enabled" : "View only"}
											{link.expiresAt ? ` · Expires ${new Date(link.expiresAt).toLocaleDateString()}` : ""}
										</p>
									</div>
									<div className="flex shrink-0 items-center gap-1.5">
										<button
											type="button"
											onClick={() => void copy(link)}
											className="rounded border ed-hairline px-2 py-0.5 hover:bg-muted"
										>
											{copiedId === link.id ? "Copied" : "Copy"}
										</button>
										<button
											type="button"
											onClick={() => void revoke(link.id)}
											className="rounded px-2 py-0.5 text-red-300 hover:bg-red-500/15"
										>
											Revoke
										</button>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
