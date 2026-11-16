import { useEffect, useState } from "react";
import { Link } from "react-router";

import { api, type Me } from "../lib/api";
import { pluralize } from "../lib/history";

interface Crumb {
	label: string;
	to?: string;
}

/** Shared dark top bar: logo mark + breadcrumb + live credits/usage + right actions. */
export function TopBar({
	projectName,
	crumbs = [],
	me,
	actions,
}: {
	projectName: string;
	crumbs?: Crumb[];
	me?: Me | null;
	actions?: React.ReactNode;
}) {
	const [openUsage, setOpenUsage] = useState(false);
	const [usage, setUsage] = useState<{ balance: number; events: Array<{ reason: string; total: number; credits: number }> } | null>(
		null,
	);

	useEffect(() => {
		if (!openUsage) return;
		api.usage().then(setUsage).catch(() => {});
	}, [openUsage]);

	return (
		<header className="relative flex h-12 shrink-0 items-center gap-2 border-b ed-hairline px-4">
			<Link
				to="/"
				aria-label="Home"
				className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
			>
				<LogoMark />
			</Link>
			{crumbs.length > 0 && <span className="text-sm text-muted-foreground">/</span>}
			<span className="truncate text-sm text-muted-foreground">{projectName}</span>
			{crumbs.map((crumb, i) => (
				<span key={i} className="flex min-w-0 items-center gap-2">
					<span className="text-sm text-muted-foreground">/</span>
					{crumb.to ? (
						<Link to={crumb.to} className="truncate text-sm hover:underline">
							{crumb.label}
						</Link>
					) : (
						<span className="truncate text-sm font-medium">{crumb.label}</span>
					)}
				</span>
			))}
			<div className="ml-auto flex items-center gap-1.5">
				{actions}
				{me?.user && (
					<div className="relative">
						<button
							type="button"
							onClick={() => setOpenUsage((v) => !v)}
							aria-expanded={openUsage}
							title="Credit balance and usage breakdown"
							className="rounded-full border ed-hairline px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
						>
							{pluralize(me.user.credits, "credit")}
						</button>
						{openUsage && (
							<div
								role="dialog"
								aria-label="Usage details"
								className="absolute right-0 top-9 z-40 w-64 rounded-xl border ed-hairline ed-panel p-3 text-xs shadow-2xl"
							>
								<div className="flex items-center justify-between font-medium">
									<span>Credits</span>
									<span>{usage?.balance ?? me.user.credits} remaining</span>
								</div>
								<div className="mt-2 space-y-1 border-t ed-hairline pt-2 text-muted-foreground">
									{!usage ? (
										<p>Loading…</p>
									) : usage.events.length === 0 ? (
										<p>No credit activity yet.</p>
									) : (
										usage.events.map((e) => (
											<div key={e.reason} className="flex items-center justify-between">
												<span className="truncate">{e.reason}</span>
												<span className="tabular-nums">
													{e.credits >= 0 ? `+${e.credits}` : e.credits} ({e.total})
												</span>
											</div>
										))
									)}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</header>
	);
}

export function LogoMark() {
	return (
		<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
			<rect x="2" y="2" width="16" height="16" rx="5" fill="oklch(0.42 0.2 272)" />
			<circle cx="10" cy="10" r="4" fill="none" stroke="white" strokeWidth="1.6" />
		</svg>
	);
}

export function PillButton({
	children,
	onClick,
	variant = "primary",
	disabled,
	title,
}: {
	children: React.ReactNode;
	onClick?: () => void;
	variant?: "primary" | "ghost";
	disabled?: boolean;
	title?: string;
}) {
	return (
		<button
			type="button"
			title={title}
			disabled={disabled}
			onClick={onClick}
			className={
				variant === "primary"
					? "rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-85 disabled:opacity-40"
					: "rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
			}
		>
			{children}
		</button>
	);
}

export function IconButton({
	children,
	onClick,
	title,
	active,
	disabled,
}: {
	children: React.ReactNode;
	onClick?: () => void;
	title: string;
	active?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			title={title}
			aria-label={title}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={`flex size-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30 ${
				active ? "bg-muted text-foreground" : ""
			}`}
		>
			{children}
		</button>
	);
}
