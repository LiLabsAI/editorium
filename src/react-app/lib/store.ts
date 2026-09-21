import { useEffect, useState } from "react";

/**
 * Minimal external store for editor state shared between the canvas, the
 * element tree, and the floating prompt card. Keeps pointer-drag updates out
 * of React reconciliation (canvas reads via subscribe).
 */

export type EditorTool = "region" | "pan";

export interface EditorState {
	tool: EditorTool;
	selectedIds: string[];
	hoveredId: string | null;
	zoom: number;
	offset: { x: number; y: number };
}

let state: EditorState = {
	tool: "region",
	selectedIds: [],
	hoveredId: null,
	zoom: 1,
	offset: { x: 0, y: 0 },
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
