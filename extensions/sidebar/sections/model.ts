import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SidebarSectionContext } from "../types.js";

export function renderModelSection(section: SidebarSectionContext): void {
	const { ctx, state, innerWidth, add, dim, options } = section;
	add(section.theme.fg("text", section.theme.bold("Model")));
	const reasoning = options.getThinkingLevel() ?? "off";
	if (ctx?.model) {
		add(truncateToWidth(`${ctx.model.id} • ${reasoning}`, innerWidth, "…"));
		add(dim(truncateToWidth(ctx.model.provider, innerWidth, "…")));
	} else {
		add(dim(`no model • ${reasoning}`));
	}
	add(
		dim(`turns ${state.turnCount}${state.isStreaming ? " • streaming" : ""}`),
	);
	if (state.lastTool) add(dim(`last tool ${state.lastTool}`));
}
