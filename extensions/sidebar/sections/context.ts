import { fmtNumber } from "../utils.js";
import type { SidebarSectionContext } from "../types.js";

export function renderContextSection(section: SidebarSectionContext): void {
	const { add, muted } = section;
	section.heading("Context");
	const usage = section.contextUsage;
	if (usage) {
		const tokenText =
			usage.tokens == null ? "unknown" : fmtNumber(usage.tokens);
		const percentText =
			usage.percent == null ? "?" : `${usage.percent.toFixed(0)}%`;
		add(`${percentText} • ${tokenText} of ${fmtNumber(usage.contextWindow)}`);
	} else {
		add(muted("not available yet"));
	}
}
