import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WidthSetting } from "./layout/width.ts";
import { errorText, isRecord } from "./util.ts";

export type ColorMode = "theme" | "vivid" | "mono";
export type IconMode = "unicode" | "ascii";
export type BodyPanel = "usage" | "activity" | "git" | "tools" | "workspace";
/** The scrolling panels, in display order. */
export const BODY_PANELS: readonly BodyPanel[] = ["usage", "activity", "git", "tools", "workspace"];
export type PanelName = "session" | "context" | BodyPanel;
export const PANEL_NAMES: readonly PanelName[] = ["session", "context", ...BODY_PANELS];

/** `<agent-dir>/pi-sidebar.json` (design §5.3). */
export interface SidebarConfig {
  enabled: boolean;
  width: WidthSetting;
  minMainWidth: number;
  panels: Record<BodyPanel, boolean>;
  /** Panels folded to their title line (a click on the title toggles this). */
  folded: PanelName[];
  /** The estimated context breakdown under the CONTEXT bar. */
  contextBreakdown: boolean;
  git: { maxFiles: number; pollSeconds: number };
  colors: ColorMode;
  icons: IconMode;
  contextWarnPercent: number;
  contextDangerPercent: number;
  recentTools: number;
  renderThrottleMs: number;
}

export function defaultConfig(): SidebarConfig {
  return {
    enabled: true,
    width: "auto",
    minMainWidth: 64,
    panels: { usage: true, activity: true, git: true, tools: true, workspace: true },
    folded: [],
    contextBreakdown: true,
    git: { maxFiles: 3, pollSeconds: 15 },
    colors: "theme",
    icons: "unicode",
    contextWarnPercent: 70,
    contextDangerPercent: 85,
    recentTools: 3,
    renderThrottleMs: 200,
  };
}

export interface Limit {
  readonly min: number;
  readonly max: number;
}

/** Accepted ranges; numbers outside are clamped (CFG-2). `git.pollSeconds` 0 turns polling off. */
export const LIMITS = {
  minMainWidth: { min: 48, max: 160 },
  maxFiles: { min: 0, max: 10 },
  pollSeconds: { min: 5, max: 600 },
  percent: { min: 1, max: 100 },
  recentTools: { min: 0, max: 10 },
  renderThrottleMs: { min: 100, max: 1000 },
} as const satisfies Record<string, Limit>;

export function clamp(value: number, limit: Limit): number {
  return Math.min(limit.max, Math.max(limit.min, Math.round(value)));
}

export interface LoadedConfig {
  config: SidebarConfig;
  warnings: string[];
}

/** Validate a parsed config file (CFG-2): unknown keys are reported, bad values keep their defaults. */
export function parseConfig(raw: unknown): LoadedConfig {
  const config = defaultConfig();
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    warnings.push("config is not a JSON object; using defaults");
    return { config, warnings };
  }
  reportUnknown(raw, config, "", warnings);
  config.enabled = readBoolean(raw.enabled, "enabled", warnings) ?? config.enabled;
  config.width = readChoice(raw.width, "width", ["auto", 28, 36] as const, warnings) ?? config.width;
  config.minMainWidth = readNumber(raw.minMainWidth, "minMainWidth", LIMITS.minMainWidth, warnings) ?? config.minMainWidth;
  if (isRecord(raw.panels)) {
    reportUnknown(raw.panels, config.panels, "panels.", warnings);
    for (const panel of BODY_PANELS) {
      config.panels[panel] = readBoolean(raw.panels[panel], `panels.${panel}`, warnings) ?? config.panels[panel];
    }
  } else if (raw.panels !== undefined) {
    warnings.push("panels must be an object");
  }
  if (Array.isArray(raw.folded)) {
    for (const name of raw.folded) {
      const panel = PANEL_NAMES.find((candidate) => candidate === name);
      if (panel === undefined) warnings.push(`folded: unknown panel ${JSON.stringify(name)} ignored`);
      else if (!config.folded.includes(panel)) config.folded.push(panel);
    }
  } else if (raw.folded !== undefined) {
    warnings.push("folded must be a list of panel names");
  }
  config.contextBreakdown = readBoolean(raw.contextBreakdown, "contextBreakdown", warnings) ?? config.contextBreakdown;
  if (isRecord(raw.git)) {
    reportUnknown(raw.git, config.git, "git.", warnings);
    config.git.maxFiles = readNumber(raw.git.maxFiles, "git.maxFiles", LIMITS.maxFiles, warnings) ?? config.git.maxFiles;
    config.git.pollSeconds = readPollSeconds(raw.git.pollSeconds, warnings) ?? config.git.pollSeconds;
  } else if (raw.git !== undefined) {
    warnings.push("git must be an object");
  }
  config.colors = readChoice(raw.colors, "colors", ["theme", "vivid", "mono"] as const, warnings) ?? config.colors;
  config.icons = readChoice(raw.icons, "icons", ["unicode", "ascii"] as const, warnings) ?? config.icons;
  config.contextWarnPercent =
    readNumber(raw.contextWarnPercent, "contextWarnPercent", LIMITS.percent, warnings) ?? config.contextWarnPercent;
  config.contextDangerPercent =
    readNumber(raw.contextDangerPercent, "contextDangerPercent", LIMITS.percent, warnings) ?? config.contextDangerPercent;
  config.recentTools = readNumber(raw.recentTools, "recentTools", LIMITS.recentTools, warnings) ?? config.recentTools;
  config.renderThrottleMs =
    readNumber(raw.renderThrottleMs, "renderThrottleMs", LIMITS.renderThrottleMs, warnings) ?? config.renderThrottleMs;
  return { config, warnings };
}

/** A missing file gives the defaults; a broken one gives the defaults plus a warning (CFG-4). */
export function loadConfig(path: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig(), warnings: [] };
    return { config: defaultConfig(), warnings: [`config not read (${errorText(error)}); using defaults`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { config: defaultConfig(), warnings: [`config is not valid JSON (${errorText(error)}); using defaults`] };
  }
  return parseConfig(raw);
}

/**
 * Write the settings that differ from the defaults (CFG-3). Keys this version does not know are kept,
 * the file is replaced atomically, and a file that is not a JSON object is left alone (CFG-4).
 */
export function saveConfig(config: SidebarConfig, path: string): void {
  let existing: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON; not overwritten`);
    }
    if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object; not overwritten`);
    existing = parsed;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(configFileContent(config, existing), null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The file content for `config`: unknown keys from `existing`, then every setting that differs from its default. */
export function configFileContent(config: SidebarConfig, existing: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, unknown> = { ...defaultConfig() };
  const current: Record<string, unknown> = { ...config };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!(key in defaults)) out[key] = value;
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = current[key];
    if (isRecord(value) && isRecord(fallback)) {
      const nested: Record<string, unknown> = {};
      const previous = existing[key];
      if (isRecord(previous)) {
        for (const [name, kept] of Object.entries(previous)) if (!(name in fallback)) nested[name] = kept;
      }
      for (const [name, setting] of Object.entries(value)) if (!same(setting, fallback[name])) nested[name] = setting;
      if (Object.keys(nested).length > 0) out[key] = nested;
    } else if (!same(value, fallback)) {
      out[key] = value;
    }
  }
  return out;
}

/** Dotted names of the settings that differ from the defaults, e.g. `width`, `panels.git`. */
export function changedSettings(config: SidebarConfig): string[] {
  return Object.entries(configFileContent(config, {})).flatMap(([key, value]) =>
    isRecord(value) ? Object.keys(value).map((name) => `${key}.${name}`) : [key],
  );
}

function reportUnknown(record: Record<string, unknown>, known: object, prefix: string, warnings: string[]): void {
  for (const key of Object.keys(record)) {
    if (!(key in known)) warnings.push(`unknown key "${prefix}${key}" ignored`);
  }
}

function readBoolean(value: unknown, name: string, warnings: string[]): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  warnings.push(`${name} must be true or false`);
  return undefined;
}

function readNumber(value: unknown, name: string, limit: Limit, warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`${name} must be a number`);
    return undefined;
  }
  const clamped = clamp(value, limit);
  if (clamped !== value) warnings.push(`${name} ${value} clamped to ${clamped}`);
  return clamped;
}

function readPollSeconds(value: unknown, warnings: string[]): number | undefined {
  if (typeof value === "number" && value <= 0) return 0;
  return readNumber(value, "git.pollSeconds", LIMITS.pollSeconds, warnings);
}

function readChoice<T extends string | number>(
  value: unknown,
  name: string,
  choices: readonly T[],
  warnings: string[],
): T | undefined {
  if (value === undefined) return undefined;
  const match = choices.find((choice) => choice === value);
  if (match !== undefined) return match;
  warnings.push(`${name} must be ${choices.map((choice) => JSON.stringify(choice)).join(", ")}`);
  return undefined;
}
