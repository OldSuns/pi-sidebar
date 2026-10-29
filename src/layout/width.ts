/** Sidebar widths (design §3.2-5): 36 columns draws boxed panels, 28 columns draws title rules. */
export type SidebarWidth = 28 | 36;
export type WidthSetting = "auto" | SidebarWidth;

/** Extra main-area columns needed before the sidebar appears or grows, so a dragged window edge does not flap. */
export const STEP_UP_MARGIN = 4;

/**
 * Pick the sidebar width for a terminal `cols` wide, given the width shown now (0 = hidden).
 * The result is a fixpoint: passing it back as `current` with the same `cols` returns it again,
 * so the layout engine may ask several times per frame.
 */
export function pickWidth(cols: number, current: 0 | SidebarWidth, setting: WidthSetting, minMainWidth: number): 0 | SidebarWidth {
  const candidates: readonly SidebarWidth[] = setting === "auto" ? [36, 28] : [setting];
  for (const width of candidates) {
    const need = minMainWidth + (width > current ? STEP_UP_MARGIN : 0);
    if (cols - width >= need) return width;
  }
  return 0;
}
