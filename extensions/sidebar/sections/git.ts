import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarSectionContext, Theme } from "../types.js";

function colorDelta(delta: string | undefined, theme: Theme): string {
	if (!delta) return "";
	const numeric = delta.match(/^(\+\d+)\/(-\d+)$/);
	if (numeric) {
		return `${theme.fg("toolDiffAdded", numeric[1])}${theme.fg("dim", "/")}${theme.fg("toolDiffRemoved", numeric[2])}`;
	}
	return theme.fg(delta === "new" ? "toolDiffAdded" : "dim", delta);
}

function gitFileLine(
	file: { code: string; path: string; delta?: string },
	innerWidth: number,
	theme: Theme,
): string {
	const codeColor = file.code.includes("D")
		? "toolDiffRemoved"
		: file.code.includes("A") || file.code.includes("?")
			? "toolDiffAdded"
			: "warning";
	const code = file.code.padEnd(2);
	const coloredCode = theme.fg(codeColor, code);
	const coloredDelta = colorDelta(file.delta, theme);
	const deltaWidth = coloredDelta ? visibleWidth(coloredDelta) + 1 : 0;
	const pathWidth = Math.max(
		1,
		innerWidth - visibleWidth(code) - 1 - deltaWidth,
	);
	const path = truncateToWidth(file.path, pathWidth, "…");
	const line = `${coloredCode} ${path}${coloredDelta ? ` ${coloredDelta}` : ""}`;
	return truncateToWidth(line, innerWidth, "");
}

export function renderGitSection(section: SidebarSectionContext): void {
	const { state, theme, add, innerWidth } = section;
	section.heading("Git");
	const git = state.git;
	if (!git.insideRepo) {
		add(
			theme.fg(git.error ? "warning" : "muted", git.error ?? "not a git repo"),
		);
		return;
	}

	if (git.branch)
		add(theme.fg("accent", truncateToWidth(git.branch, innerWidth, "…")));
	const summary = `${git.changedFiles} files  ${theme.fg("toolDiffAdded", `+${git.insertions}`)} ${theme.fg("toolDiffRemoved", `-${git.deletions}`)}`;
	add(summary);

	if (git.files.length === 0) {
		add(theme.fg("success", "clean working tree"));
		return;
	}

	const max = state.gitDetail
		? section.options.maxFiles
		: Math.min(5, section.options.maxFiles);
	for (const file of git.files.slice(0, max)) {
		add(gitFileLine(file, innerWidth, theme));
	}
	if (git.files.length > max)
		add(theme.fg("dim", `…${git.files.length - max} more`));
}
