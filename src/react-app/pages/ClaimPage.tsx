import { useState } from "react";

import { api, describeError } from "../lib/api";
import { LogoMark } from "../components/TopBar";

/** Restore the pre-auth owner account with the OWNER_CLAIM_KEY secret. The key
 * is POSTed in the body — never put in the URL, where it would be logged. */
export function ClaimPage() {
	const [key, setKey] = useState("");
	const [status, setStatus] = useState<"idle" | "busy" | "error">("idle");
	const [message, setMessage] = useState("");

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!key.trim()) return;
		setStatus("busy");
		try {
			await api.claimOwner(key.trim());
			window.location.assign("/");
		} catch (err) {
			setStatus("error");
			setMessage(
				err instanceof Error && err.message === "invalid_key" ? "That key isn't valid." : describeError(err),
			);
		}
	}

	return (
		<div className="flex h-screen flex-col items-center justify-center gap-4 px-4">
			<LogoMark />
			<h1 className="text-lg font-semibold">Restore your account</h1>
			<form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-2">
				<label htmlFor="claim-key" className="text-sm text-muted-foreground">
					Owner key
				</label>
				<input
					id="claim-key"
					type="password"
					autoComplete="off"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					className="rounded-xl border ed-hairline bg-card px-3 py-2 text-sm outline-none focus:border-ring"
				/>
				<button
					type="submit"
					disabled={status === "busy" || !key.trim()}
					className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
				>
					{status === "busy" ? "Checking…" : "Restore"}
				</button>
				{status === "error" && (
					<p role="alert" className="text-sm text-red-300">
						{message}
					</p>
				)}
			</form>
		</div>
	);
}
