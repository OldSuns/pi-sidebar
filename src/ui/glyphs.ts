import type { ColorMode, IconMode } from "../config.ts";
import type { PartName } from "../state/snapshot.ts";

export interface BarGlyphs {
  readonly full: string;
  /** Eighths of a cell, from empty to seven eighths; a single entry means whole cells only. */
  readonly partials: readonly string[];
  readonly track: string;
  readonly threshold: string;
}

export interface BoxGlyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

/** Every symbol the sidebar draws, all one column wide (R-5); `icons ascii` swaps in plain ASCII. */
export interface Glyphs {
  readonly ascii: boolean;
  readonly title: string;
  /** Marks a folded panel or a closed section; `unfolded` an open one; `fewer` closes a long list. */
  readonly folded: string;
  readonly unfolded: string;
  readonly fewer: string;
  readonly ellipsis: string;
  readonly dot: string;
  readonly minus: string;
  readonly none: string;
  readonly ready: string;
  readonly working: readonly string[];
  readonly compacting: string;
  readonly error: string;
  readonly ok: string;
  readonly fail: string;
  readonly run: string;
  readonly cancelled: string;
  readonly queued: string;
  readonly branch: string;
  readonly ahead: string;
  readonly behind: string;
  readonly edge: string;
  readonly bar: BarGlyphs;
  readonly box: BoxGlyphs;
  /** Cells of the context breakdown bar, one glyph per part. */
  readonly parts: Readonly<Record<PartName, string>>;
  /** The mark before each part in the breakdown list. */
  readonly partMarks: Readonly<Record<PartName, string>>;
}

const UNICODE: Glyphs = {
  ascii: false,
  title: "✦",
  folded: "▸",
  unfolded: "▾",
  fewer: "▴",
  ellipsis: "…",
  dot: "·",
  minus: "−",
  none: "—",
  ready: "●",
  working: ["◐", "◓", "◑", "◒"],
  compacting: "⟳",
  error: "✗",
  ok: "✓",
  fail: "✗",
  run: "▶",
  cancelled: "○",
  queued: "↳",
  branch: "⎇",
  ahead: "↑",
  behind: "↓",
  edge: "│",
  // With colour the track is a solid band in a dark tint of the CONTEXT colour.
  bar: { full: "█", partials: ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"], track: "█", threshold: "┊" },
  box: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
  // Colour tells the parts apart. Terminals draw "█" over the whole cell, so stacked marks would merge
  // into one column; "■" leaves a gap above and below.
  parts: { system: "█", tools: "█", messages: "█", toolResults: "█", summary: "█", other: "█" },
  partMarks: { system: "■", tools: "■", messages: "■", toolResults: "■", summary: "■", other: "■" },
};

/** Without colour, shades and patterns tell the parts apart. */
const UNICODE_MONO: Glyphs = {
  ...UNICODE,
  bar: { ...UNICODE.bar, track: "░" },
  parts: { system: "█", tools: "▓", messages: "▒", toolResults: "░", summary: "▚", other: "·" },
  // The marks repeat the patterns of the bar.
  partMarks: { system: "█", tools: "▓", messages: "▒", toolResults: "░", summary: "▚", other: "·" },
};

const ASCII: Glyphs = {
  ascii: true,
  title: "*",
  folded: ">",
  unfolded: "v",
  fewer: "^",
  ellipsis: "...",
  dot: "-",
  minus: "-",
  none: "-",
  ready: "*",
  working: ["-", "\\", "|", "/"],
  compacting: "~",
  error: "x",
  ok: "+",
  fail: "x",
  run: ">",
  cancelled: "o",
  queued: ">",
  branch: "git:",
  ahead: "^",
  behind: "v",
  edge: "|",
  bar: { full: "#", partials: [""], track: ".", threshold: ":" },
  box: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
  parts: { system: "S", tools: "T", messages: "M", toolResults: "R", summary: "U", other: "o" },
  partMarks: { system: "S", tools: "T", messages: "M", toolResults: "R", summary: "U", other: "o" },
};

export function glyphsFor(icons: IconMode, colors: ColorMode): Glyphs {
  if (icons === "ascii") return ASCII;
  return colors === "mono" ? UNICODE_MONO : UNICODE;
}
