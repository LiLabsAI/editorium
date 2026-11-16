import { useMemo, useState } from "react";

import { fileUrl, type ImageDto } from "../lib/api";

interface TreeNode {
	img: ImageDto;
	depth: number;
}

function buildBranchTree(family: ImageDto[]): TreeNode[] {
	if (!family.length) return [];
	const byId = new Map(family.map((f) => [f.id, f]));
	const children = new Map<string, ImageDto[]>();
	const roots: ImageDto[] = [];
	for (const img of family) {
		if (img.sourceImageId && byId.has(img.sourceImageId)) {
			const list = children.get(img.sourceImageId) ?? [];
			list.push(img);
			children.set(img.sourceImageId, list);
		} else {
			roots.push(img);
		}
	}

	const out: TreeNode[] = [];
	const seen = new Set<string>();
	function walk(node: ImageDto, depth: number) {
		if (seen.has(node.id)) return;
		seen.add(node.id);
		out.push({ img: node, depth });
		for (const child of children.get(node.id) ?? []) {
			walk(child, depth + 1);
		}
	}
	for (const r of roots) walk(r, 0);
	for (const img of family) if (!seen.has(img.id)) out.push({ img, depth: 0 });
	return out;
}

/** Collapsible branch tree rail showing parent->child edits, undo/redo step navigation, and duplicate. */
export function BranchRail({
	family,
	currentId,
	onOpen,
	onDuplicate,
	busy,
}: {
	family: ImageDto[];
	currentId: string;
	onOpen: (imageId: string) => void;
	onDuplicate: () => void;
	busy?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const nodes = useMemo(() => buildBranchTree(family), [family]);

	return (
		<aside
			aria-label="Branch timeline"
			className={`ed-panel flex shrink-0 flex-col border-r ed-hairline transition-all ${
				expanded ? "w-48" : "w-16"
			}`}
		>
			<div className="flex items-center justify-between border-b ed-hairline px-2 py-2">
				{expanded && <span className="text-xs font-medium text-muted-foreground">Branches ({nodes.length})</span>}
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					title={expanded ? "Collapse branch tree" : "Expand branch tree"}
					aria-label={expanded ? "Collapse branch tree" : "Expand branch tree"}
					aria-expanded={expanded}
					className="mx-auto rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
				>
					{expanded ? "«" : "»"}
				</button>
			</div>

			<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 py-2">
				{nodes.map(({ img, depth }) => {
					const active = img.id === currentId;
					const indentPx = expanded ? Math.min(3, depth) * 10 : Math.min(2, depth) * 4;
					return (
						<button
							key={img.id}
							type="button"
							title={img.filenameLabel}
							onClick={() => onOpen(img.id)}
							style={{ marginLeft: indentPx }}
							className={`flex items-center gap-2 rounded-lg border-2 p-0.5 text-left transition ${
								expanded ? "w-[calc(100%-var(--indent,0px))]" : ""
							} ${active ? "border-[rgba(99,120,255,0.95)] bg-indigo-500/10" : "border-transparent opacity-75 hover:opacity-100"}`}
						>
							<img
								src={fileUrl(img.id, "thumb", img.currentVersionId ?? undefined)}
								alt={img.filenameLabel}
								loading="lazy"
								className="size-10 shrink-0 rounded-md object-cover"
							/>
							{expanded && (
								<div className="min-w-0 flex-1 pr-1">
									<p className="truncate text-xs font-medium">{img.filenameLabel}</p>
									<p className="text-[10px] text-muted-foreground">{depth === 0 ? "Root" : `Branch · L${depth}`}</p>
								</div>
							)}
						</button>
					);
				})}
			</div>

			<div className="border-t ed-hairline p-2">
				<button
					type="button"
					disabled={busy}
					onClick={onDuplicate}
					title="Duplicate this photo as a branch"
					className="w-full rounded-lg border ed-hairline py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
				>
					{expanded ? "Duplicate branch" : "Dup"}
				</button>
			</div>
		</aside>
	);
}
