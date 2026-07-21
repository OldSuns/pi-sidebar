import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { Theme } from "./types.ts";

// ── Types ──────────────────────────────────────────────────────

export interface PanelConfig {
	/** Section heading label. Defaults to the panel key. */
	label?: string;
	/** Session custom entry type to read data from (e.g. "goal-state"). */
	entryType: string;
	/**
	 * Variable names to display, keyed by the data field path inside the entry,
	 * valued by the display label.
	 *
	 * Nested fields use dot notation: "goal.text" → "目標"
	 */
	variables: Record<string, string>;
	/** Compact mode: render variables inline instead of one-per-line. */
	compact?: boolean;
	/**
	 * Max lines to show for this panel's variables (non-compact mode only).
	 * When exceeded, remaining variables are hidden with a "+N more" indicator.
	 * 0 or undefined = unlimited.
	 * The global panelsCompact mode uses this as the default limit.
	 */
	maxLines?: number;
}

export interface SidebarUIConfig {
	panels?: Record<string, PanelConfig>;
}

// ── Config loader ──────────────────────────────────────────────

/**
 * Load and merge sidebar-ui.json from project-local and global locations.
 * Project-local (.pi/sidebar-ui.json) overrides global (~/.pi/agent/sidebar-ui.json).
 */
export function loadSidebarUIConfig(cwd: string | undefined): SidebarUIConfig {
	const globalPath = join(os.homedir(), ".pi", "agent", "sidebar-ui.json");
	const localPath = cwd ? join(cwd, ".pi", "sidebar-ui.json") : undefined;

	const global_: SidebarUIConfig = tryReadJson(globalPath) ?? {};
	const local_: SidebarUIConfig = localPath ? (tryReadJson(localPath) ?? {}) : {};

	// Merge: local panels override global panels with the same key
	const merged: SidebarUIConfig = { panels: { ...global_.panels } };
	if (local_.panels) {
		for (const [key, value] of Object.entries(local_.panels)) {
			if (merged.panels) merged.panels[key] = value;
		}
	}
	return merged;
}

function tryReadJson(path: string): SidebarUIConfig | undefined {
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf8")) as SidebarUIConfig;
		}
	} catch {
		// ignore malformed files
	}
	return undefined;
}

// ── Panel renderer ─────────────────────────────────────────────

const RESET_FG = "\x1b[39m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const LABEL_GRAY = "\x1b[38;2;128;128;128m";
const VALUE_TEXT = "\x1b[38;2;212;212;212m";
const EMPTY_GRAY = "\x1b[38;2;130;130;130m";

/**
 * Find the latest session entry with the given customType.
 * Returns the data if it has any non-null value,
 * or undefined if the entry is missing / all-null (i.e. explicitly cleared).
 */
function findSessionEntry(
	ctx: ExtensionContext | undefined,
	entryType: string,
): Record<string, unknown> | undefined {
	if (!ctx?.sessionManager) return undefined;
	try {
		const entries =
			(ctx.sessionManager as unknown as { getBranch?: () => Array<Record<string, unknown>> }).getBranch?.() ??
			(ctx.sessionManager as unknown as { getEntries?: () => Array<Record<string, unknown>> }).getEntries?.() ??
			[];
		// Iterate backwards — return the latest entry's data if it has any
		// non-null value; if the latest is all-null, treat as cleared.
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === entryType) {
				const data = entry.data as Record<string, unknown> | undefined;
				if (!data) return undefined;
				// All null → explicitly cleared
				if (!Object.values(data).some((v) => v !== null && v !== undefined)) {
					return undefined;
				}
				return data;
			}
		}
	} catch {
		// ignore
	}
	return undefined;
}

/**
 * Resolve a dot-notation path (e.g. "goal.text") against an object.
 */
function resolvePath(obj: unknown, path: string): unknown {
	let current: unknown = obj;
	for (const key of path.split(".")) {
		if (current === null || current === undefined) return undefined;
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "number") {
		if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
		if (value >= 1_000) return Math.round(value / 1_000) + "k";
		if (Number.isInteger(value)) return String(value);
		return value.toFixed(1);
	}
	if (typeof value === "boolean") return value ? "yes" : "no";
	return String(value);
}

/**
 * Render external panels between context and git sections.
 */
export function renderExternalPanels(
	ctx: ExtensionContext | undefined,
	config: SidebarUIConfig,
	theme: Theme,
	innerWidth: number,
	add: (line?: string) => void,
	heading: (label: string) => void,
	options?: { maxLines?: number },
): void {
	if (!config.panels) return;

	const globalMaxLines = options?.maxLines;

	for (const [panelKey, panelCfg] of Object.entries(config.panels)) {
		const data = findSessionEntry(ctx, panelCfg.entryType);

		// Check if any variable has a real value
		const hasValue = Object.keys(panelCfg.variables).some((fieldPath) => {
			const v = resolvePath(data, fieldPath);
			return v !== null && v !== undefined;
		});

		if (!hasValue) {
			// Collapsed: bold label in default white + gray "(empty)"
			add(`${BOLD}${panelCfg.label ?? panelKey}${BOLD_OFF} ${EMPTY_GRAY}(empty)${RESET_FG}`);
			continue;
		}

		// Has data — render section heading + variables
		heading(panelCfg.label ?? panelKey);

		if (panelCfg.compact) {
			const parts: string[] = [];
			for (const [fieldPath, displayLabel] of Object.entries(panelCfg.variables)) {
				const value = resolvePath(data, fieldPath);
				if (value !== null && value !== undefined) {
					parts.push(
						`${LABEL_GRAY}${displayLabel}:${RESET_FG} ${VALUE_TEXT}${formatValue(value)}${RESET_FG}`,
					);
				}
			}
			add(parts.join(`  ${LABEL_GRAY}·${RESET_FG}  `));
		} else {
			const maxLines = panelCfg.maxLines ?? globalMaxLines ?? Infinity;
			let lineCount = 0;
			let overflow = 0;
			const SIDEBAR_WIDTH = 34;
			const contentWidth = Math.max(4, SIDEBAR_WIDTH - 2);

			for (const [fieldPath, displayLabel] of Object.entries(panelCfg.variables)) {
				const value = resolvePath(data, fieldPath);
				if (value === null || value === undefined) continue;

				// Blank line between variables (except first)
				if (lineCount > 0) {
					if (lineCount >= maxLines) { overflow++; continue; }
					add();
					lineCount++;
				}

				// Build full colored text: "label: value"
				const formatted = formatValue(value);
				const fullText = `${LABEL_GRAY}${displayLabel}:${RESET_FG} ${VALUE_TEXT}${formatted}${RESET_FG}`;

				// Wrap the full text to fit content width
				const wrappedLines = wrapTextWithAnsi(fullText, contentWidth);

				// Check if all wrapped lines fit within the remaining budget
				if (lineCount + wrappedLines.length > maxLines) {
					overflow++;
					continue;
				}

				for (const wl of wrappedLines) {
					add(wl);
					lineCount++;
				}
			}

			// Show "+N more" indicator if we truncated
			if (overflow > 0) {
				add(`${EMPTY_GRAY}└ +${overflow} more${RESET_FG}`);
			}
		}
	}
}
