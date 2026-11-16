import { useEffect, useState } from "react";

/**
 * Minimal external store for high-frequency editor state shared between the
 * WebGL/2D canvas, layer drawer, and prompt composer. Keeps 60fps pointer drags
 * and pan/zoom out of React reconciliation.
 */

export type EditorTool =
	| "select"
	| "box"
	| "brush"
	| "eraser"
	| "lasso"
	| "wand"
	| "crop"
	| "outpaint"
	| "text"
	| "pan";

export type CompareMode = "off" | "peek" | "split" | "side";

export interface EditorState {
	tool: EditorTool;
	brushRadiusPx: number;
	wandTolerance: number;
	selectedIds: string[];
	hoveredId: string | null;
	zoom: number;
	offset: { x: number; y: number };
	compareMode: CompareMode;
	compareSplit: number;
	showMaskOverlay: boolean;
}

let state: EditorState = {
	tool: "box",
	brushRadiusPx: 28,
	wandTolerance: 28,
	selectedIds: [],
	hoveredId: null,
	zoom: 1,
	offset: { x: 0, y: 0 },
	compareMode: "off",
	compareSplit: 0.5,
	showMaskOverlay: true,
};

const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

export const editorStore = {
	get: () => state,
	set(patch: Partial<EditorState>) {
		state = { ...state, ...patch };
		emit();
	},
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};

/** React binding for the editor store. */
export function useEditorState(): EditorState {
	const [, force] = useState(0);
	useEffect(() => editorStore.subscribe(() => force((n) => n + 1)), []);
	return state;
}
