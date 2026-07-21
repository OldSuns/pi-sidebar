import path from "node:path";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SidebarSectionContext } from "../types.js";

/**
 * Render the current session name above the model section.
 * Always shows — derives a name from the session file when no custom name is set.
 */
export function renderSessionSection(section: SidebarSectionContext): void {
	const { ctx, add } = section;

	const sessionManager = ctx?.sessionManager as
		| {
				getSessionName?: () => string | undefined;
				sessionFile?: string;
		  }
		| undefined;

	// 1) Custom session name set via /session name
	const customName = sessionManager?.getSessionName?.();
	if (customName) {
		add();
		const nameText = section.theme.fg("text", section.theme.bold(customName));
		const wrapped = wrapTextWithAnsi(nameText, section.innerWidth);
		for (const line of wrapped) {
			add(line);
		}
		return;
	}

	// 2) Derive name from session file (e.g. "2026-07-14 18:12.jsonl")
	const sessionFile = sessionManager?.sessionFile;
	if (sessionFile) {
		const basename = path.basename(sessionFile, ".jsonl");
		// Strip trailing session-ID hash: "1749900000_session-id" → "1749900000"
		const ts = basename.includes("_") ? basename.slice(0, basename.indexOf("_")) : basename;
		const dateStr = formatSessionTimestamp(ts);
		add();
		// Wrap instead of truncate to show the full name
		const nameText = section.theme.fg("text", section.theme.bold(dateStr));
		const wrapped = wrapTextWithAnsi(nameText, section.innerWidth);
		for (const line of wrapped) {
			add(line);
		}
		return;
	}

	// 3) Last resort
	add();
	add(section.theme.fg("text", section.theme.bold("Pi Session")));
}

/**
 * Format a millisecond timestamp (or numeric string) to a human-readable
 * date+time string like "7/14 18:12".
 */
function formatSessionTimestamp(ts: string): string {
	const ms = Number(ts);
	if (!Number.isFinite(ms) || ms <= 0) return ts;
	const d = new Date(ms);
	const month = d.getMonth() + 1;
	const day = d.getDate();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${month}/${day} ${hh}:${mm}`;
}
