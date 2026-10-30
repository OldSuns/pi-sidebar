import { visibleWidth } from "@earendil-works/pi-tui";
import type { BarGlyphs } from "./glyphs.ts";
import type { Role } from "./palette.ts";

/** A run of text in one colour role. Lines are built from runs so widths are measured before styling. */
export interface Seg {
  readonly text: string;
  readonly role?: Role;
  readonly bold?: boolean;
  /** Background role; only the context bar's partial cell uses it, so the uncovered part shows the track. */
  readonly bg?: Role;
}
export type Line = readonly Seg[];

export function seg(text: string, role?: Role, bold = false): Seg {
  return bold ? { text, role, bold } : { text, role };
}

export function lineWidth(line: Line): number {
  let width = 0;
  for (const part of line) width += visibleWidth(part.text);
  return width;
}

/**
 * Cut plain text to `width` columns, ending in the ellipsis. Unlike pi-tui's `truncateToWidth` it adds
 * no reset codes, which would cut off the colour of a styled run halfway.
 */
export function truncatePlain(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const room = width - visibleWidth(ellipsis);
  return room <= 0 ? head(text, width) : head(text, room) + ellipsis;
}

function head(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > width) break;
    out += char;
    used += charWidth;
  }
  return out;
}

/** Cut (ending in the ellipsis) or pad the line so it is exactly `width` columns (R-1). */
export function fit(line: Line, width: number, ellipsis = "…"): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const part of line) {
    const partWidth = visibleWidth(part.text);
    if (used + partWidth <= width) {
      out.push(part);
      used += partWidth;
      continue;
    }
    if (width - used > 0) {
      const cut = truncatePlain(part.text, width - used, ellipsis);
      out.push({ ...part, text: cut });
      used += visibleWidth(cut);
    }
    break;
  }
  if (used < width) out.push(seg(" ".repeat(width - used)));
  return out;
}

/** Left part, flexible gap, right-aligned part. The left part gives way first when both do not fit. */
export function lr(left: Line, right: Line, width: number, ellipsis = "…"): Seg[] {
  const leftWidth = lineWidth(left);
  const rightWidth = lineWidth(right);
  if (rightWidth === 0) return fit(left, width, ellipsis);
  if (leftWidth + 1 + rightWidth <= width) return [...left, seg(" ".repeat(width - leftWidth - rightWidth)), ...right];
  const room = width - rightWidth - 1;
  if (room < 4) return fit(left, width, ellipsis);
  return [...fit(left, room, ellipsis), seg(" "), ...right];
}

/** Keep the end of a path and elide the start (R-8), e.g. "…ssion-manager.ts". */
export function elideStart(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  const room = max - visibleWidth(ellipsis);
  return room <= 0 ? tail(text, max) : ellipsis + tail(text, room);
}

/** Keep the start of a command or pattern and elide the end (R-8), e.g. "git status --sh…". */
export function elideEnd(text: string, max: number, ellipsis = "…"): string {
  return truncatePlain(text, max, ellipsis);
}

function tail(text: string, width: number): string {
  const chars = Array.from(text);
  let out = "";
  let used = 0;
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index] ?? "";
    const charWidth = visibleWidth(char);
    if (used + charWidth > width) break;
    out = char + out;
    used += charWidth;
  }
  return out;
}

/**
 * Context bar: used cells in `fill`, the rest as track, and a mark at the auto-compact threshold.
 * The last `accentCells` of the used part show this run's growth in the accent colour.
 */
export function bar(
  percent: number | null,
  thresholdPercent: number | undefined,
  cells: number,
  fill: Role,
  glyphs: BarGlyphs,
  accentCells = 0,
): Seg[] {
  if (cells <= 0) return [];
  const marks: { text: string; role: Role; bg?: Role }[] = [];
  if (percent !== null) {
    const exact = (Math.max(0, Math.min(100, percent)) / 100) * cells;
    const steps = glyphs.partials.length;
    const full = steps > 1 ? Math.floor(exact) : Math.round(exact);
    for (let index = 0; index < full; index++) marks.push({ text: glyphs.full, role: fill });
    const partial = steps > 1 ? glyphs.partials[Math.floor((exact - full) * steps)] : undefined;
    // The partial glyph covers only the left of its cell; the track colour behind it fills the rest.
    if (partial && marks.length < cells) marks.push({ text: partial, role: fill, bg: "track" });
    for (let index = Math.max(0, marks.length - accentCells); index < marks.length; index++) {
      marks[index] = { ...marks[index], text: marks[index]?.text ?? glyphs.full, role: "run" };
    }
  }
  while (marks.length < cells) marks.push({ text: glyphs.track, role: "track" });
  if (thresholdPercent !== undefined) {
    const at = Math.min(cells - 1, Math.round((thresholdPercent / 100) * cells));
    if (marks[at]?.role === "track") marks[at] = { text: glyphs.threshold, role: "faint" };
  }
  const runs: Seg[] = [];
  for (const mark of marks) {
    const last = runs.at(-1);
    if (last && last.role === mark.role && last.bg === mark.bg) runs[runs.length - 1] = { ...last, text: last.text + mark.text };
    else runs.push(mark.bg ? { ...seg(mark.text, mark.role), bg: mark.bg } : seg(mark.text, mark.role));
  }
  return runs;
}
