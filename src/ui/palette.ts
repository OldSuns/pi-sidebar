import type { Theme, ThemeColor, ThemeStyle } from "@earendil-works/pi-coding-agent";
import { type Color, colorToOkhsl, mixColors, okhslColor, rgbColor } from "@earendil-works/pi-tui";
import type { ColorMode } from "../config.ts";
import { PART_NAMES, type PartName, type ThinkingLevel } from "../state/snapshot.ts";
import type { Line, Seg } from "./text.ts";

export type PanelRole = "session" | "context" | "usage" | "activity" | "git" | "workspace" | "tools";
export type Role =
  | PanelRole
  | `tint:${PanelRole}`
  | `part:${PartName}`
  | "label"
  | "value"
  | "faint"
  | "sep"
  | "track"
  | "input"
  | "output"
  | "cache"
  | "cost"
  | "ok"
  | "warn"
  | "err"
  | "run"
  | `think:${ThinkingLevel}`
  | "add"
  | "del"
  | "mod"
  | "untracked";

const PANELS: readonly PanelRole[] = ["session", "context", "usage", "activity", "git", "workspace", "tools"];

/** Theme tokens that give each panel its own hue (design §4.4; all distinct in catppuccin mocha). */
const PANEL_TOKENS: Readonly<Record<PanelRole, ThemeColor>> = {
  session: "mdLink",
  context: "syntaxOperator",
  usage: "syntaxType",
  activity: "syntaxString",
  git: "syntaxNumber",
  workspace: "syntaxKeyword",
  tools: "syntaxVariable",
};

/** `colors vivid` panel colours: a fixed palette, one hue per panel. */
const VIVID_RGB: Readonly<Record<PanelRole, readonly [number, number, number]>> = {
  session: [110, 168, 254],
  context: [125, 211, 252],
  usage: [234, 200, 110],
  activity: [74, 222, 128],
  git: [255, 159, 67],
  workspace: [177, 140, 255],
  tools: [244, 114, 182],
};

/** The fixed hue for each panel, in OKHSL degrees. */
const VIVID_HUES = Object.fromEntries(
  PANELS.map((panel) => [panel, colorToOkhsl(rgbColor(...VIVID_RGB[panel])).h]),
) as Readonly<Record<PanelRole, number>>;

/** OKHSL saturation below which a colour reads as grey. */
const MIN_SATURATION = 0.25;
/** Hues closer than this, in degrees, read as the same colour. */
const MIN_HUE_GAP = 20;

const hueGap = (first: number, second: number): number => {
  const gap = Math.abs(first - second) % 360;
  return Math.min(gap, 360 - gap);
};

const mean = (values: readonly number[], fallback: number): number =>
  values.length === 0 ? fallback : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Panel colours for `colors theme`: the theme's own tokens when they give seven distinct, colourful
 * hues, as catppuccin mocha does. Pi's built-in dark and light themes map CONTEXT to grey and SESSION
 * and WORKSPACE to the same blue; there every panel takes its fixed hue at the theme's own
 * saturation and lightness instead, so the panels stay apart and suit the background.
 */
function themePanelColors(colors: Theme["colors"]): Record<PanelRole, ThemeColor | Color> {
  const channels = PANELS.map((panel) => colorToOkhsl(colors[PANEL_TOKENS[panel]]));
  const distinct = channels.every(
    (color, index) => color.s >= MIN_SATURATION && channels.slice(0, index).every((other) => hueGap(color.h, other.h) >= MIN_HUE_GAP),
  );
  if (distinct) return { ...PANEL_TOKENS };
  const colourful = channels.filter((color) => color.s >= MIN_SATURATION);
  const saturation = mean(colourful.map((color) => color.s), 0.6);
  const lightness = mean(colourful.map((color) => color.l), 0.65);
  return Object.fromEntries(PANELS.map((panel) => [panel, okhslColor(VIVID_HUES[panel], saturation, lightness)])) as Record<PanelRole, Color>;
}

/**
 * Panel colours for `colors vivid`: fixed hues, made for dark backgrounds. Dark text means a light
 * background; there the same hues come darker.
 */
function vividPanelColors(colors: Theme["colors"]): Record<PanelRole, Color> {
  const light = colorToOkhsl(colors.text).l < 0.5;
  return Object.fromEntries(
    PANELS.map((panel) => [panel, light ? okhslColor(VIVID_HUES[panel], 0.9, 0.5) : rgbColor(...VIVID_RGB[panel])]),
  ) as Record<PanelRole, Color>;
}

/** Breakdown parts borrow panel hues; "other" stays muted. */
const PART_PANELS: Readonly<Record<Exclude<PartName, "other">, PanelRole>> = {
  system: "workspace",
  tools: "tools",
  messages: "session",
  toolResults: "git",
  summary: "usage",
};

const THINKING_TOKENS: Readonly<Record<ThinkingLevel, ThemeColor>> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

/** How far frames fade from the panel colour toward `borderMuted`. */
const FRAME_MIX = 0.35;
/** How far the context-bar track fades from the CONTEXT colour toward `borderMuted`. */
const TRACK_MIX = 0.72;
/**
 * sRGB keeps the panel's hue family. OKLCH turns warm hues toward red on the way to a bluish
 * `borderMuted`: the yellow USAGE frame came out salmon (204,157,150) in catppuccin mocha.
 */
const MIX_SPACE = "srgb";

type Foreground = ThemeColor | Color;

/** Colour roles resolved for one theme and colour mode (R-4). Rebuilt when either changes. */
export class Palette {
  readonly mode: ColorMode;
  private readonly theme: Theme;
  private readonly roles = new Map<Role, Foreground>();
  /** Roles that may also paint a background. None in mono, where the track is a pattern, not a colour. */
  private readonly backgrounds = new Map<Role, Color>();

  constructor(theme: Theme, mode: ColorMode) {
    this.theme = theme;
    this.mode = mode;
    const set = (role: Role, foreground: Foreground) => this.roles.set(role, foreground);
    set("label", "muted");
    set("value", "text");
    set("faint", "dim");
    set("ok", "success");
    set("warn", "warning");
    set("err", "error");
    set("mod", "warning");
    set("untracked", "dim");
    for (const [level, token] of Object.entries(THINKING_TOKENS) as [ThinkingLevel, ThemeColor][]) {
      set(`think:${level}`, mode === "mono" ? "muted" : token);
    }
    if (mode === "mono") {
      set("sep", "dim");
      set("track", "dim");
      set("run", "text");
      set("add", "success");
      set("del", "error");
      for (const panel of PANELS) {
        set(panel, "text");
        set(`tint:${panel}`, "dim");
      }
      for (const part of PART_NAMES) set(`part:${part}`, part === "other" ? "dim" : "text");
      for (const role of ["input", "output", "cache", "cost"] as const) set(role, "text");
      return;
    }
    set("sep", "borderMuted");
    set("run", "accent");
    set("add", "toolDiffAdded");
    set("del", "toolDiffRemoved");
    const colors = theme.colors;
    const panels = mode === "vivid" ? vividPanelColors(colors) : themePanelColors(colors);
    const panelColor = (panel: PanelRole): Color => {
      const color = panels[panel];
      return typeof color === "string" ? colors[color] : color;
    };
    for (const panel of PANELS) {
      set(panel, panels[panel]);
      set(`tint:${panel}`, mixColors(panelColor(panel), colors.borderMuted, FRAME_MIX, MIX_SPACE));
    }
    for (const [part, panel] of Object.entries(PART_PANELS) as [PartName, PanelRole][]) set(`part:${part}`, panelColor(panel));
    set("part:other", "muted");
    const track = mixColors(panelColor("context"), colors.borderMuted, TRACK_MIX, MIX_SPACE);
    set("track", track);
    this.backgrounds.set("track", track);
    // Usage figures reuse the panel hues: input blue, output violet, cache cyan, cost orange.
    set("input", panelColor("session"));
    set("output", panelColor("workspace"));
    set("cache", panelColor("context"));
    set("cost", panelColor("git"));
  }

  paint(part: Seg): string {
    if (part.text === "") return "";
    const foreground = part.role === undefined ? undefined : this.roles.get(part.role);
    const background = part.bg === undefined ? undefined : this.backgrounds.get(part.bg);
    if (foreground === undefined && background === undefined) return part.bold ? this.theme.bold(part.text) : part.text;
    const style: ThemeStyle = {};
    if (foreground !== undefined) style.fg = foreground;
    if (background !== undefined) style.bg = background;
    if (part.bold) style.bold = true;
    return this.theme.style(part.text, style);
  }

  paintLine(line: Line): string {
    let out = "";
    for (const part of line) out += this.paint(part);
    return out;
  }
}
