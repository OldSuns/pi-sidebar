// Text previews of the real sidebar renderer (src/ui) with the sample data of the tests: the states a
// real run rarely shows. The images of the design doc come from a real Pi (scripts/screenshot.ts, and
// its --states for the CONTEXT states in §6.6). This only prints. Colours are catppuccin mocha or
// those of a Pi theme file. Run from the repo root:
//
//   node --import ./test/support/register.mjs scripts/preview.ts plain|ansi [P1,P3] [--theme <theme.json>]
import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToRgb, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ColorMode, IconMode } from "../src/config.ts";
import type { SidebarSnapshot } from "../src/state/snapshot.ts";
import { box } from "../src/ui/frame.ts";
import { glyphsFor } from "../src/ui/glyphs.ts";
import { Palette } from "../src/ui/palette.ts";
import { buildPanel, type Tier } from "../src/ui/panels.ts";
import { bodyRows, headerRows, type SidebarView } from "../src/ui/sidebar.ts";
import { fit, seg } from "../src/ui/text.ts";
import { sampleSnapshot, testView } from "../test/helpers.ts";

/** catppuccin-tui-mocha (pi-catppuccin-tui/themes/catppuccin-tui-mocha.json), the tokens the sidebar uses. */
const MOCHA: Readonly<Record<string, string>> = {
  text: "#cdd6f4",
  muted: "#a6adc8",
  dim: "#7f849c",
  accent: "#cba6f7",
  success: "#a6e3a1",
  warning: "#f9e2af",
  error: "#f38ba8",
  border: "#585b70",
  borderMuted: "#45475a",
  mdLink: "#89b4fa",
  syntaxOperator: "#89dceb",
  syntaxType: "#f9e2af",
  syntaxString: "#a6e3a1",
  syntaxNumber: "#fab387",
  syntaxKeyword: "#cba6f7",
  syntaxVariable: "#eba0ac",
  thinkingOff: "#45475a",
  thinkingMinimal: "#585b70",
  thinkingLow: "#89b4fa",
  thinkingMedium: "#74c7ec",
  thinkingHigh: "#cba6f7",
  thinkingXhigh: "#f38ba8",
  toolDiffAdded: "#a6e3a1",
  toolDiffRemoved: "#f38ba8",
};
/** The theme being previewed: catppuccin mocha, or a Pi theme file given with `--theme <file>`. */
const look: { name: string; tokens: Readonly<Record<string, string | number>> } = { name: "catppuccin-tui-mocha", tokens: MOCHA };

/** A Pi theme file: `colors` by token, each a colour or the name of one of its `vars`. */
function useTheme(file: string): void {
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    name?: string;
    vars?: Record<string, string | number>;
    colors?: Record<string, string | number>;
  };
  const vars = json.vars ?? {};
  const tokens: Record<string, string | number> = {};
  for (const [token, value] of Object.entries(json.colors ?? {})) tokens[token] = typeof value === "string" ? (vars[value] ?? value) : value;
  look.name = json.name ?? file;
  look.tokens = tokens;
}

const tokenColor = (token: string): Color => parseColor(look.tokens[token] ?? look.tokens.text ?? "#cdd6f4");

/** A theme that styles with 24-bit SGR codes, as Pi does in a truecolor terminal (mixed colours rounded). */
const THEME = {
  get name() {
    return look.name;
  },
  colors: new Proxy({}, { get: (_target, token) => tokenColor(String(token)) }),
  style(text: string, options: { fg?: string | Color; bg?: Color; bold?: boolean }): string {
    const fg = options.fg === undefined ? undefined : colorToRgb(typeof options.fg === "string" ? tokenColor(options.fg) : options.fg);
    const bg = options.bg === undefined ? undefined : colorToRgb(options.bg);
    const sgr = fg ? `\u001b[38;2;${Math.round(fg.r)};${Math.round(fg.g)};${Math.round(fg.b)}m` : "";
    const bgSgr = bg ? `\u001b[48;2;${Math.round(bg.r)};${Math.round(bg.g)};${Math.round(bg.b)}m` : "";
    const open = `${sgr}${bgSgr}${options.bold ? "\u001b[1m" : ""}`;
    const close = `${options.bold ? "\u001b[22m" : ""}${bg ? "\u001b[49m" : ""}${fg ? "\u001b[39m" : ""}`;
    return `${open}${text}${close}`;
  },
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as unknown as Theme;

const pad = (line: string, width: number) => line + " ".repeat(Math.max(0, width - visibleWidth(line)));

interface ColumnOptions {
  view?: SidebarView;
  colors?: ColorMode;
  icons?: IconMode;
  rows?: number;
  low?: boolean;
}

/** One sidebar column as Pi would draw it: the edge, the pinned panels, then the body from its top. */
function column(snapshot: SidebarSnapshot, tier: Tier, options: ColumnOptions = {}): string[] {
  const colors = options.colors ?? "theme";
  const icons = options.icons ?? "unicode";
  const view: SidebarView = { ...(options.view ?? testView()), g: glyphsFor(icons, colors) };
  const palette = new Palette(THEME, colors);
  const width = tier === "compact" ? 28 : 36;
  const inner = width - (tier === "compact" ? 2 : 1);
  const rows = [
    ...headerRows(snapshot, view, tier, inner, options.low ?? false),
    ...bodyRows(snapshot, view, tier, inner),
  ];
  const edge = tier === "compact" ? `${palette.paint(seg(view.g.edge, "sep"))} ` : " ";
  const lines = rows.map((line) => edge + palette.paintLine(fit(line.segs, inner, view.g.ellipsis)));
  if (options.rows === undefined) return lines;
  while (lines.length < options.rows) lines.push(pad(edge, width));
  return lines.slice(0, options.rows);
}

/** Columns next to each other, `gap` spaces apart, with a faint caption above each. */
function sideBySide(columns: { caption: string; lines: string[]; width: number }[], gap = 3): string[] {
  const height = Math.max(...columns.map((part) => part.lines.length));
  const caption = (text: string) => THEME.style(text, { fg: "dim" });
  const out = [columns.map((part) => pad(caption(part.caption), part.width)).join(" ".repeat(gap)), ""];
  for (let index = 0; index < height; index++) {
    out.push(columns.map((part) => pad(part.lines[index] ?? "", part.width)).join(" ".repeat(gap)));
  }
  return out;
}

const open = (overrides: Partial<SidebarView["expanded"]>, base: SidebarView = testView()): SidebarView => ({
  ...base,
  expanded: { ...base.expanded, ...overrides },
});

// ---- P1: context states ----

function contextBox(caption: string, snapshot: SidebarSnapshot, view: SidebarView = open({ breakdown: false })): { caption: string; lines: string[]; width: number } {
  const palette = new Palette(THEME, "theme");
  const panel = buildPanel("context", snapshot, view, "normal", 31);
  const lines = box(panel.role, panel.title, panel.rows, 35, view.g).map((line) => palette.paintLine(fit(line.segs, 35, view.g.ellipsis)));
  return { caption, lines, width: 35 };
}

function contextStates(): string[] {
  const base = sampleSnapshot();
  const context = (overrides: Partial<NonNullable<SidebarSnapshot["context"]>>) =>
    sampleSnapshot({ context: { tokens: 76_400, window: 200_000, percent: 38.2, compactAt: 183_616, ...overrides } });
  const rows: { caption: string; lines: string[]; width: number }[][] = [
    [
      contextBox("(a) normal, this run +1.3k", base),
      contextBox("(b) warning >= 70%", context({ tokens: 149_200, percent: 74.6, delta: 4_100 })),
    ],
    [
      contextBox("(c) danger >= 85%", context({ tokens: 178_600, percent: 89.3, delta: 2_000 })),
      contextBox("(d) auto-compaction off", context({ compactAt: undefined, delta: undefined })),
    ],
    [
      contextBox("(e) after compaction", context({ tokens: null, percent: null, delta: undefined })),
      contextBox("(f) no context window", sampleSnapshot({ context: undefined })),
    ],
  ];
  return rows.flatMap((pair, index) => [...sideBySide(pair, 4), ...(index < rows.length - 1 ? [""] : [])]);
}

// ---- P2: a low terminal ----

function lowTerminal(): string[] {
  return column(sampleSnapshot(), "normal", { rows: 16, low: true });
}

// ---- P3: without colour, and in plain ASCII ----

function asciiAndMono(): string[] {
  return sideBySide([
    { caption: "icons ascii · width 28", lines: column(sampleSnapshot(), "compact", { icons: "ascii", rows: 30 }), width: 28 },
    { caption: "colors mono · width 36", lines: column(sampleSnapshot(), "normal", { colors: "mono", rows: 30 }), width: 36 },
  ]);
}

const PREVIEWS: Readonly<Record<string, { title: string; draw: () => string[] }>> = {
  P1: { title: "context states", draw: contextStates },
  P2: { title: "a low terminal", draw: lowTerminal },
  P3: { title: "ascii icons and mono colours", draw: asciiAndMono },
};

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");

const args = process.argv.slice(2);
const themeAt = args.indexOf("--theme");
if (themeAt >= 0) {
  const file = args[themeAt + 1];
  if (!file) throw new Error("--theme needs a Pi theme file");
  useTheme(file);
  args.splice(themeAt, 2);
}
const [mode = "plain", argument] = args;
const names = argument ? argument.split(",") : Object.keys(PREVIEWS);
for (const name of names) if (!PREVIEWS[name]) throw new Error(`unknown preview ${name}`);
if (mode === "plain") {
  console.log(names.map((name) => `=== ${name} ===\n${plain(PREVIEWS[name]?.draw() ?? [])}`).join("\n"));
} else if (mode === "ansi") {
  console.log(
    names.map((name) => `\u001b[1m${name} · ${PREVIEWS[name]?.title ?? ""}\u001b[22m\n\n${(PREVIEWS[name]?.draw() ?? []).join("\n")}\n`).join("\n"),
  );
} else {
  console.error(`unknown mode "${mode}" (plain | ansi)`);
  process.exit(2);
}
