/** Pure helpers for the editor history panel and composer (phase 5). */

import type { Box, HistoryTurn, OpClass } from "./api";

export const CLASS_LABEL: Record<OpClass, string> = {
	adjust: "Adjust · no AI",
	enhance: "Enhance",
	segment: "Remove background",
	local: "Region edit",
	reimagine: "Reimagine · whole photo",
	generate: "Generate",
	answer: "Question",
	upload: "Original",
};

/** What the result guarantees, in plain words. */
export const CLASS_PROMISE: Partial<Record<OpClass, string>> = {
	adjust: "Adjusted, no AI",
	enhance: "Same photo, more detail",
	segment: "Subject untouched",
	local: "Outside the region unchanged",
	reimagine: "May change other details",
	generate: "New image",
};

export const PENDING_LABEL: Partial<Record<OpClass, string>> = {
	enhance: "Enhancing…",
	segment: "Removing background…",
	local: "Editing the region…",
	reimagine: "Reimagining…",
	generate: "Generating…",
	answer: "Thinking…",
};

function third(v: number, words: [string, string, string]): string {
	return v < 1 / 3 ? words[0] : v > 2 / 3 ? words[2] : words[1];
}

/** "upper left", "center", "lower right" … for a normalized box. */
export function regionWords(box: Box): string {
	const col = third(box.x + box.w / 2, ["left", "center", "right"]);
	const row = third(box.y + box.h / 2, ["upper", "middle", "lower"]);
	if (row === "middle") return col === "center" ? "center" : `${col} side`;
	return col === "center" ? `${row === "upper" ? "top" : "bottom"} center` : `${row} ${col}`;
}

const QUESTION = /\?\s*$|^(what|where|who|why|how|is|are|can|could|do|does|which|should|tell me|describe)\b/i;
/** Whole-photo intents that should not trigger the "draw a box" hint. */
const GLOBAL_WORDS = new Set([
	"photo", "image", "picture", "whole", "background", "backdrop", "lighting", "light", "colors", "colours",
	"color", "colour", "style", "mood", "scene", "overall", "exposure", "contrast", "tone", "sharpness", "quality",
	"resolution", "atmosphere", "weather", "season", "time", "look", "vibe",
]);

export function isQuestion(text: string): boolean {
	return QUESTION.test(text.trim());
}

/**
 * If a whole-photo instruction names one object ("the drink", "his eyes"),
 * return that object so the composer can suggest a region edit instead —
 * Reimagine may change other details (the green-drink report).
 */
export function singleTarget(text: string): string | null {
	if (!text.trim() || isQuestion(text)) return null;
	const match = /\b(?:the|his|her|their|my|its|this|that)\s+([a-z]+(?:\s[a-z]+)?)/i.exec(text);
	if (!match) return null;
	// Keep a compound noun ("contact lenses") but stop at what the change is
	// ("eyes blue" → "eyes", "drink into" → "drink").
	const words = match[1]!.toLowerCase().split(" ");
	const noun = words.length > 1 && !NOT_NOUN.has(words[1]!) ? words : words.slice(0, 1);
	if (noun.some((w) => GLOBAL_WORDS.has(w))) return null;
	return `the ${noun.join(" ")}`;
}

/** Words that describe the change rather than extend the object's name. */
const NOT_NOUN = new Set([
	"red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "black", "white", "gray", "grey", "gold",
	"silver", "bigger", "smaller", "brighter", "darker", "lighter", "longer", "shorter", "into", "to", "with", "and",
	"more", "less", "look", "a", "an", "in", "on", "from", "for", "so", "is", "are",
]);

export interface ComposerMode {
	kind: "region" | "ask" | "reimagine";
	label: string;
	detail: string;
}

export function composerMode(text: string, hasSelection: boolean): ComposerMode {
	if (hasSelection) {
		return { kind: "region", label: "Edit region", detail: "2 credits · everything outside the box stays unchanged" };
	}
	if (isQuestion(text)) return { kind: "ask", label: "Ask", detail: "Free · answers about this photo" };
	return { kind: "reimagine", label: "Reimagine whole photo", detail: "2 credits · AI may change other details" };
}

export function isPending(turn: HistoryTurn): boolean {
	return turn.reply.status === "queued" || turn.reply.status === "running";
}

/** Retry is offered for AI actions that can be replayed from their request. */
export function canRetry(turn: HistoryTurn): boolean {
	const cls = turn.request.opClass;
	return !turn.derived && !!turn.request.imageId && !!cls && ["enhance", "segment", "local", "reimagine"].includes(cls);
}

export type HistoryFilter = "all" | "edits" | "chat";

export function matchesFilter(turn: HistoryTurn, filter: HistoryFilter): boolean {
	if (filter === "all") return true;
	const chat = turn.request.opClass === "answer";
	return filter === "chat" ? chat : !chat;
}
