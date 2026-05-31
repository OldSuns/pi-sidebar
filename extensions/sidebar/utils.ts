import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GitState } from "./types.js";

export function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function envSignedInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

export function fmtNumber(n: number): string {
	return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export function padAnsi(line: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(line));
	return line + " ".repeat(pad);
}

export function parseShortstat(
	shortstat: string,
): Pick<GitState, "changedFiles" | "insertions" | "deletions"> {
	const changedFiles = Number(
		shortstat.match(/(\d+) files? changed/)?.[1] ?? 0,
	);
	const insertions = Number(shortstat.match(/(\d+) insertions?/)?.[1] ?? 0);
	const deletions = Number(shortstat.match(/(\d+) deletions?/)?.[1] ?? 0);
	return { changedFiles, insertions, deletions };
}

export function parseNumstat(numstat: string): Map<string, string> {
	const deltas = new Map<string, string>();
	for (const line of numstat.split("\n")) {
		const trimmed = line.trimEnd();
		if (!trimmed) continue;
		const [added, deleted, ...pathParts] = trimmed.split("\t");
		const path = pathParts.join("\t").trim();
		if (!path) continue;
		const addedText = added === "-" ? "bin" : `+${added}`;
		const deletedText = deleted === "-" ? "bin" : `-${deleted}`;
		deltas.set(
			path,
			addedText === "bin" || deletedText === "bin"
				? "bin"
				: `${addedText}/${deletedText}`,
		);
	}
	return deltas;
}

export function shouldHideSidebar(
	state: { enabled: boolean; isStreaming: boolean },
	autohideWorking: boolean,
): boolean {
	return !state.enabled || (autohideWorking && state.isStreaming);
}

export function formatFileLine(
	file: { code: string; path: string; delta?: string },
	width: number,
): string {
	const code = file.code.padEnd(2);
	const delta = file.delta ? ` ${file.delta}` : "";
	const pathWidth = Math.max(
		1,
		width - visibleWidth(code) - visibleWidth(delta) - 1,
	);
	return `${code} ${truncateToWidth(file.path, pathWidth, "…")}${delta}`;
}
