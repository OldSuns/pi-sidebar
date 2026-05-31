import type { SidebarSectionContext } from "../types.js";

export function renderHintSection(section: SidebarSectionContext): void {
	section.add();
	section.add(section.dim("/sidebar status"));
}
