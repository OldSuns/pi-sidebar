import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SidebarSectionContext } from "../types.js";

export function renderLocationSection(section: SidebarSectionContext): void {
	const { ctx, add, dim, innerWidth } = section;
	section.heading("Location");
	add(dim(truncateToWidth(ctx?.cwd ?? process.cwd(), innerWidth, "…")));
}
