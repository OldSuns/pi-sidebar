import { fmtNumber } from "../utils.js";
import type { SidebarSectionContext } from "../types.js";

export function renderContextSection(section: SidebarSectionContext): void {
	const { ctx, add, muted } = section;
	section.heading("Context");
	const usage = ctx?.getContextUsage?.();
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
