// npm run screenshots: the images in docs/design/preview, taken from a real Pi (design §6.0).
//
// Pi's interactive mode runs in a virtual terminal with this extension and a scripted model. Home, agent
// directory and project are temporary (a git repository with a copy of this one), so nothing touches
// the real ~/.pi and nothing goes over the network. The frames come from pi-tui itself
// (getScreenLines); a small HTML terminal draws them, and Chrome or Edge saves them as PNG files.
// Needs git; the images assume the Cascadia Mono font.
//
//   node --import ./test/support/register.mjs scripts/screenshot.ts [--theme <name|theme.json>] [--shots <names>] [--out <dir>]
//   node --import ./test/support/register.mjs scripts/screenshot.ts --states [--theme <name|theme.json>]
//
// --theme defaults to catppuccin mocha when pi-catppuccin-tui is installed, else Pi's dark theme;
// --shots keeps only the named images (e.g. pi-fullscreen). CHROME=<path> picks the browser.
// --states starts one isolated Pi per CONTEXT state (design §6.6) and draws them in one image.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { CreateAgentSessionRuntimeFactory, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";

const option = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(option("--out") ?? join(root, "docs", "design", "preview"));
// The default look is catppuccin mocha from the pi-catppuccin-tui package when it is installed, else Pi's dark.
const mocha = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-catppuccin-tui", "themes", "catppuccin-tui-mocha.json");
const themeArg = option("--theme") ?? (existsSync(mocha) ? mocha : "dark");
const only = option("--shots")?.split(",");
const stateOut = option("--state-out");

// ---- one CONTEXT panel per real state, for the gallery in the design doc ----
// Each state needs its own model or settings, so `--states` starts one isolated Pi per state and
// draws the panels it gets back into one image. Nothing is forged: the panel shows Pi's own context
// usage, drawn by the sidebar in a real session.
interface StateSpec {
  caption: string;
  /** Context window of the scripted model; 0 leaves the model without one. */
  window: number;
  /** false turns auto-compaction off in the isolated settings. */
  compaction?: boolean;
  /** Tokens kept free by auto-compaction; the default 16384 does not fit a small window. */
  reserve?: number;
}
const STATE_PROMPT = "Which files does the GIT panel read, and how often?";
const STATE_REPLY = "It reads git status and git diff, and refreshes on events and every 15 s while idle.";
/** The same exchange is 2 988 tokens; these windows put it at 74.7% and 89.2%, as §6.6 describes. */
const STATES: Record<string, StateSpec> = {
  normal: { caption: "normal", window: 200_000 },
  warning: { caption: "warning, 70% or more", window: 4_000, reserve: 500 },
  danger: { caption: "danger, 85% or more", window: 3_350, reserve: 500 },
  "compaction-off": { caption: "auto-compaction off", window: 200_000, compaction: false },
  "no-window": { caption: "no context window", window: 0 },
};
const stateName = option("--state");
const state = stateName === undefined ? undefined : STATES[stateName];
if (stateName !== undefined && state === undefined) throw new Error(`unknown state "${stateName}"`);
/** Thrown to stop a state run before the base images. */
const captured = Symbol("state captured");
const browserEnv = { ...process.env };

// ---- an isolated home, set before any Pi module reads the environment ----

const work = mkdtempSync(join(tmpdir(), "pi-sidebar-shots-"));
const home = join(work, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(home, "projects", "pi-sidebar");
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_HYPERLINKS: "0",
  COLORTERM: "truecolor",
  GIT_CONFIG_NOSYSTEM: "1",
});
delete process.env.PI_SIDEBAR_CONFIG;

const pi = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const tuiLib = await import("@earendil-works/pi-tui");

const MODEL_ID = "claude-sonnet-5-5";
const COLUMNS = 150;
const NARROW_COLUMNS = 96;
const ROWS = 44;
const SIDEBAR = 36;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ---- the project Pi works in: a git repository with a copy of this one ----

function git(...args: string[]): void {
  const identity = ["-c", "user.name=Pi Sidebar", "-c", "user.email=pi-sidebar@example.invalid", "-c", "core.autocrlf=false"];
  const result = spawnSync("git", [...identity, ...args], { cwd: project, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.error?.message}`);
}
mkdirSync(project, { recursive: true });
for (const name of ["src", "test", "README.md", "package.json", "tsconfig.json"]) {
  cpSync(join(root, name), join(project, name), { recursive: true });
}
git("-c", "init.defaultBranch=main", "init", "-q");
git("add", ".");
git("commit", "-q", "-m", "Initial commit");

// ---- settings and theme of the temporary agent directory ----

interface ThemeJson {
  name?: string;
  appearance?: string;
  vars?: Record<string, string | number>;
  colors?: Record<string, string | number>;
  export?: Record<string, string | number>;
}
const builtinTheme = (name: string) => join(pi.getPackageDir(), "dist", "modes", "interactive", "theme", `${name}.json`);
const themePath = existsSync(themeArg) ? resolve(themeArg) : builtinTheme(themeArg);
const themeJson = JSON.parse(readFileSync(themePath, "utf8")) as ThemeJson;
const themeName = themeJson.name ?? themeArg;
const label = themeName.replace(/^catppuccin-tui-/, "");
mkdirSync(join(agentDir, "themes"), { recursive: true });
if (existsSync(themeArg)) cpSync(themePath, join(agentDir, "themes", `${themeName}.json`));
const settings: Record<string, unknown> = { theme: themeName, tuiMode: "fullscreen", lastChangelogVersion: pi.VERSION, enableInstallTelemetry: false };
if (state?.compaction === false) settings.compaction = { enabled: false };
else if (state?.reserve !== undefined) settings.compaction = { reserveTokens: state.reserve };
writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

interface Look {
  background: string;
  foreground: string;
}
/** Background and text colour of the theme, as a terminal set up for it shows them. */
function lookOf(json: ThemeJson): Look {
  const color = (value: string | number | undefined, fallback: string): string => {
    const resolved = typeof value === "string" && json.vars?.[value] !== undefined ? json.vars[value] : value;
    if (resolved === undefined || resolved === "") return fallback;
    try {
      return tuiLib.colorToHex(tuiLib.parseColor(resolved));
    } catch {
      return fallback;
    }
  };
  const light = json.appearance === "light";
  return { background: color(json.export?.cardBg, light ? "#ffffff" : "#1e1e2e"), foreground: color(json.colors?.text, light ? "#333333" : "#cdd6f4") };
}

// ---- a virtual terminal: Pi draws into it, the script types into it ----

class ScreenshotTerminal implements Terminal {
  columns = COLUMNS;
  rows = ROWS;
  readonly kittyProtocolActive = false;
  private input?: (data: string) => void;
  private resized?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resized = onResize;
  }
  stop(): void {
    this.input = undefined;
  }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}

  send(data: string): void {
    this.input?.(data);
  }
  resize(columns: number): void {
    this.columns = columns;
    this.resized?.();
  }
}

// ---- a scripted model: pi-ai's faux provider, plus the request hooks and costs of a real one ----

const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const core = ai.createFauxCore({
  api: "screenshots",
  provider: "anthropic",
  models: [{ id: MODEL_ID, name: "Claude Sonnet 5.5", reasoning: true, contextWindow: state?.window ?? 200_000, maxTokens: 16_384, cost: RATES }],
  tokensPerSecond: 70,
});
/** Time to first token of each response, in order. */
const TTFT_MS = [1_400, 850, 950, 700];
let requests = 0;

/** Pi's providers call onPayload (Pi emits before_provider_request there) and onResponse; faux calls neither. */
function stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const out = ai.createAssistantMessageEventStream();
  const ttft = TTFT_MS[requests++] ?? 800;
  void (async () => {
    await options?.onPayload?.({ model: model.id }, model);
    await sleep(ttft);
    await options?.onResponse?.({ status: 200, headers: {} }, model);
    for await (const event of core.streamSimple(model, context, options)) {
      if (event.type === "done") event.message.usage.cost = ai.calculateCost(model, event.message.usage);
      out.push(event);
    }
    out.end();
  })();
  return out;
}
const provider = ai.createProvider({
  id: "anthropic",
  name: "Anthropic",
  auth: { apiKey: { name: "Screenshots", resolve: async () => ({ auth: { apiKey: "screenshots" }, source: "screenshots" }) } },
  models: core.models,
  api: { stream, streamSimple: stream },
});

// ---- the conversation ----

const NOTE = [
  "# GIT panel",
  "",
  "- Runs `git status` and `git diff --numstat`, one process at a time.",
  "- Refreshes 500 ms after a tool that may change files, every 5 s at most while the agent works.",
  "- Polls every 15 s while idle; starts no git process while the panel is hidden or off.",
  "",
].join("\n");
const README_LINE = "SESSION and CONTEXT stay pinned at the top; the other panels scroll under them.";
const ANSWER = [
  "The GIT panel runs git only while it is on screen:",
  "",
  "- **After a tool** that may change files (anything but `read`, `grep`, `find` and `ls`), 500 ms later, or 5 s apart while the agent works.",
  "- **While idle** it polls every `git.pollSeconds`, 15 s by default.",
  "- **Never** while the panel is hidden or turned off.",
  "",
  "I added a line about it to the README and the details to `notes/git-panel.md`.",
].join("\n");
core.setResponses([
  ai.fauxAssistantMessage(
    [
      ai.fauxThinking("The refresh logic should live in the git monitor. Read it and find where the poll interval is used."),
      ai.fauxText("Let me look at the git monitor first."),
      ai.fauxToolCall("read", { path: "src/git/monitor.ts", offset: 114, limit: 30 }),
      ai.fauxToolCall("read", { path: "src/config.ts", offset: 1, limit: 40 }),
    ],
    { stopReason: "toolUse" },
  ),
  ai.fauxAssistantMessage([ai.fauxToolCall("bash", { command: "sleep 2 && git status --short && git log --oneline -1" })], { stopReason: "toolUse" }),
  ai.fauxAssistantMessage(
    [
      ai.fauxText("Now the note."),
      ai.fauxToolCall("edit", {
        path: "README.md",
        edits: [{ oldText: README_LINE, newText: `${README_LINE}\nThe GIT panel runs git only while it is on screen; see notes/git-panel.md.` }],
      }),
      ai.fauxToolCall("write", { path: "notes/git-panel.md", content: NOTE }),
    ],
    { stopReason: "toolUse" },
  ),
  ai.fauxAssistantMessage(ANSWER),
]);
/** A state needs one exchange, not the whole scenario. */
if (state) core.setResponses([ai.fauxAssistantMessage(STATE_REPLY)]);

// ---- a helper extension: registers the model, reaches the TUI, captures frames ----

let tui: TUI | undefined;
function helper(api: ExtensionAPI): void {
  api.registerProvider(provider);
  // The script expects every tool call to succeed; a failure is a problem of the scenario.
  api.on("tool_execution_end", (event) => {
    if (event.isError) console.error(`\n${event.toolName} failed: ${JSON.stringify(event.result).slice(0, 400)}`);
  });
  api.on("session_start", (_event, ctx) => {
    // A zero-line widget, like the sidebar's own probe: its factory hands over the TUI.
    ctx.ui.setWidget("screenshots:tui", (handle) => {
      tui = handle;
      return { render: () => [], invalidate() {} } satisfies Component;
    });
  });
}

const terminal = new ScreenshotTerminal();
/** Settles, then renders a frame and returns its lines. */
async function frame(): Promise<string[]> {
  await sleep(350);
  if (!tui) throw new Error("no TUI handle yet");
  tui.renderNow(true);
  return (tui as TUI & { getScreenLines(): string[] }).getScreenLines().slice(0, terminal.rows);
}
async function until(what: string, test: (lines: string[]) => boolean, timeoutMs = 20_000): Promise<string[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const lines = await frame();
    if (test(lines)) return lines;
    if (Date.now() > end) {
      const text = lines.map((line) => tuiLib.stripTerminalSequences(line).trimEnd()).join("\n");
      throw new Error(`timed out waiting for ${what} (${terminal.columns} columns):\n${text}`);
    }
    await sleep(200);
  }
}
const has = (text: string) => (lines: string[]) => lines.some((line) => tuiLib.stripTerminalSequences(line).includes(text));
async function type(text: string): Promise<void> {
  for (const char of text) terminal.send(char);
  await sleep(100);
}
async function enter(text: string): Promise<void> {
  await type(text);
  terminal.send("\r");
}
/** A click on the first cell showing `text` in the sidebar, as an SGR mouse report. */
async function click(text: string): Promise<void> {
  const lines = (await frame()).map((line) => tuiLib.stripTerminalSequences(line));
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? "";
    const at = line.indexOf(text, Math.max(0, line.length - SIDEBAR - 2));
    if (at < 0) continue;
    const x = tuiLib.visibleWidth(line.slice(0, at)) + 1;
    terminal.send(`\u001b[<0;${x};${row + 1}M`);
    await sleep(30);
    terminal.send(`\u001b[<0;${x};${row + 1}m`);
    return;
  }
  throw new Error(`"${text}" is not on screen`);
}

// ---- frames as HTML ----

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}
interface Cell {
  text: string;
  /** 2 for wide characters; their second cell has width 0. */
  width: number;
  style: Style;
}

const rgb = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`;
const BASIC = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"]
  .concat(["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]);
function xterm(index: number): string {
  if (index < 16) return BASIC[index] ?? "#ffffff";
  if (index >= 232) return rgb(8 + (index - 232) * 10, 8 + (index - 232) * 10, 8 + (index - 232) * 10);
  const steps = [0, 95, 135, 175, 215, 255];
  const n = index - 16;
  return rgb(steps[Math.floor(n / 36)] ?? 0, steps[Math.floor(n / 6) % 6] ?? 0, steps[n % 6] ?? 0);
}

function sgr(style: Style, params: number[]): Style {
  let next: Style = { ...style };
  for (let index = 0; index < params.length; index++) {
    const code = params[index] ?? 0;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) next = { ...next, bold: false, dim: false };
    else if (code === 3 || code === 23) next.italic = code === 3;
    else if (code === 4 || code === 24) next.underline = code === 4;
    else if (code === 7 || code === 27) next.inverse = code === 7;
    else if (code === 9 || code === 29) next.strike = code === 9;
    else if (code === 39) delete next.fg;
    else if (code === 49) delete next.bg;
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30];
    else if (code >= 90 && code <= 97) next.fg = BASIC[code - 82];
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40];
    else if (code >= 100 && code <= 107) next.bg = BASIC[code - 92];
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (params[index + 1] === 2) {
        next[key] = rgb(params[index + 2] ?? 0, params[index + 3] ?? 0, params[index + 4] ?? 0);
        index += 4;
      } else if (params[index + 1] === 5) {
        next[key] = xterm(params[index + 2] ?? 0);
        index += 2;
      }
    }
  }
  return next;
}

const segmenter = new Intl.Segmenter();
/** One frame line as terminal cells: SGR styles applied, other escape sequences dropped. */
function toCells(line: string): Cell[] {
  const cells: Cell[] = [];
  let style: Style = {};
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\u001b") {
      const kind = line[index + 1];
      let end = index + 2;
      if (kind === "[") {
        while (end < line.length && !/[@-~]/.test(line[end] ?? "")) end++;
        if (line[end] === "m") style = sgr(style, line.slice(index + 2, end).split(";").map((value) => Number(value || 0)));
        index = end + 1;
      } else if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
        while (end < line.length && line[end] !== "\u0007" && !(line[end] === "\u001b" && line[end + 1] === "\\")) end++;
        index = end + (line[end] === "\u0007" ? 1 : 2);
      } else {
        index += 2;
      }
      continue;
    }
    const stop = line.indexOf("\u001b", index);
    const text = line.slice(index, stop < 0 ? line.length : stop);
    for (const { segment } of segmenter.segment(text)) {
      const width = tuiLib.visibleWidth(segment);
      if (width === 0) continue;
      cells.push({ text: segment, width, style });
      for (let extra = 1; extra < width; extra++) cells.push({ text: "", width: 0, style });
    }
    index += text.length;
  }
  return cells;
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function span(text: string, style: Style, look: Look): string {
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) [fg, bg] = [bg ?? look.background, fg ?? look.foreground];
  const css = [
    fg ? `color:${fg}` : "",
    bg ? `background:${bg}` : "",
    style.bold ? "font-weight:700" : "",
    style.italic ? "font-style:italic" : "",
    style.dim ? "opacity:.6" : "",
    style.underline || style.strike ? `text-decoration:${style.underline ? "underline" : ""} ${style.strike ? "line-through" : ""}` : "",
  ].filter(Boolean);
  return css.length > 0 ? `<span style="${css.join(";")}">${text}</span>` : text;
}

/** Columns `from` to `from + width` of one line. Symbols are pinned to their cells: fallback fonts have other widths. */
function rowHtml(line: string, from: number, width: number, look: Look): string {
  const cells = toCells(line);
  let html = "";
  let run = "";
  let runStyle: Style = {};
  let runKey = "";
  for (let column = from; column < from + width; column++) {
    const cell = cells[column] ?? { text: " ", width: 1, style: {} };
    const text = cell.width === 0 ? (column === from ? " " : "") : cell.text;
    if (text === "") continue;
    const key = JSON.stringify(cell.style);
    if (key !== runKey) {
      html += run === "" ? "" : span(run, runStyle, look);
      run = "";
      runStyle = cell.style;
      runKey = key;
    }
    run += /^[\x20-\x7e]$/.test(text) ? escapeHtml(text) : `<i class="w${cell.width === 2 ? 2 : 1}">${escapeHtml(text)}</i>`;
  }
  return html + (run === "" ? "" : span(run, runStyle, look));
}

interface Shot {
  caption?: string;
  lines: string[];
  /** First column and number of columns to show. */
  from: number;
  width: number;
  look: Look;
}

const FONT_PX = 15;
/** Cascadia Mono: 1200 of 2048 units per cell; 1.2 em rows let block glyphs fill the cell, as in a terminal. */
const CELL_W = (FONT_PX * 1200) / 2048;
const CELL_H = Math.round(FONT_PX * 1.2);
const PAD = 14;
const GAP = 24;
const CAPTION_H = 26;

function page(shots: Shot[], perRow = shots.length): { html: string; width: number; height: number } {
  const captions = shots.some((shot) => shot.caption !== undefined);
  const groups: Shot[][] = [];
  for (let index = 0; index < shots.length; index += perRow) groups.push(shots.slice(index, index + perRow));
  const groupHeight = (group: Shot[]): number =>
    Math.max(...group.map((shot) => shot.lines.length)) * CELL_H + 2 * PAD + (captions ? CAPTION_H : 0);
  const groupWidth = (group: Shot[]): number =>
    group.reduce((sum, shot) => sum + shot.width * CELL_W + 2 * PAD, 0) + GAP * (group.length - 1);
  const width = Math.ceil(Math.max(...groups.map(groupWidth)));
  const height = groups.reduce((sum, group) => sum + groupHeight(group), 0) + GAP * (groups.length - 1);
  const outer = shots.length > 1 ? "#11111b" : (shots[0]?.look.background ?? "#000");
  const rows = groups
    .map((group) => {
      const rowHeight = groupHeight(group);
      const panels = group.map((shot) => {
        const body = shot.lines.map((line) => rowHtml(line, shot.from, shot.width, shot.look)).join("\n");
        const caption = captions ? `<div class="cap" style="color:${shot.look.foreground}">${escapeHtml(shot.caption ?? "")}</div>` : "";
        return `<div class="shot" style="background:${shot.look.background};color:${shot.look.foreground};height:${rowHeight - 2 * PAD}px">${caption}<pre>${body}</pre></div>`;
      });
      return `<div class="row">${panels.join("")}</div>`;
    })
    .join("\n");
  const html = `<!doctype html>
<meta charset="utf-8">
<style>
html,body{margin:0;background:${outer}}
.col{display:flex;flex-direction:column;gap:${GAP}px}
.row{display:flex;gap:${GAP}px;align-items:flex-start}
.shot{padding:${PAD}px}
.cap{font:600 13px system-ui,sans-serif;height:${CAPTION_H}px;opacity:.75}
pre{margin:0;font-family:"Cascadia Mono",Consolas,monospace;font-size:${FONT_PX}px;line-height:${CELL_H}px;font-variant-ligatures:none}
i{font-style:normal;display:inline-block;text-align:center;overflow:visible;line-height:${CELL_H}px}
i.w1{width:1ch}i.w2{width:2ch}
</style>
<div class="col">${rows}</div>
`;
  return { html, width, height };
}

function findBrowser(): string {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => path !== undefined && existsSync(path));
  if (!found) throw new Error("no Chrome or Edge found; set CHROME to the browser executable");
  return found;
}

const pages: { name: string; html: string; width: number; height: number }[] = [];
function save(name: string, shots: Shot[], perRow?: number): void {
  if (only && !only.includes(name)) return;
  pages.push({ name: `${name}-${label}`, ...page(shots, perRow) });
  if (process.argv.includes("--text")) {
    const text = shots.map((shot) => shot.lines.map((line) => tuiLib.stripTerminalSequences(line).trimEnd()).join("\n"));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}-${label}.txt`), `${text.join("\n\n")}\n`, "utf8");
  }
}

/** Renders the saved pages with a headless browser, one PNG each. */
function writeImages(): void {
  const browser = findBrowser();
  mkdirSync(outDir, { recursive: true });
  for (const { name, html, width, height } of pages) {
    const file = join(work, `${name}.html`);
    writeFileSync(file, html, "utf8");
    const png = join(outDir, `${name}.png`);
    const result = spawnSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        `--user-data-dir=${join(work, "browser")}`,
        `--window-size=${width},${height}`,
        `--screenshot=${png}`,
        pathToFileURL(file).href,
      ],
      { env: browserEnv, encoding: "utf8", timeout: 60_000 },
    );
    if (!existsSync(png)) throw new Error(`${browser} wrote no ${png}: ${result.stderr || result.error?.message}`);
    console.log(`wrote ${png} (${width}x${height})`);
  }
}

/** The CONTEXT panel of the sidebar, from its top border to its bottom border. */
function contextBlock(lines: string[]): string[] {
  const tail = lines.map((line) => tuiLib.stripTerminalSequences(line).slice(-SIDEBAR));
  const title = tail.findIndex((line) => line.includes("✦ CONTEXT"));
  if (title < 1) throw new Error("no CONTEXT panel on screen");
  const bottom = tail.findIndex((line, index) => index > title && line.trimStart().startsWith("╰"));
  if (bottom < 0) throw new Error("the CONTEXT panel has no bottom border");
  return lines.slice(title - 1, bottom + 1);
}

/** The node_modules that holds Pi; the child processes are started after the temporary home is set, so they need it. */
function piModulesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")));
  while (basename(dir) !== "node_modules" && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

// `--states`: one isolated Pi per state, then all the panels in one image.
if (process.argv.includes("--states")) {
  const shots: Shot[] = [];
  for (const [name, spec] of Object.entries(STATES)) {
    const file = join(work, `state-${name}.json`);
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "--state", name, "--state-out", file, "--theme", themeArg],
      { stdio: "inherit", env: { ...process.env, PI_NODE_MODULES: piModulesDir() } },
    );
    if (child.status !== 0 || !existsSync(file)) {
      console.error(`state ${name} failed`);
      process.exitCode = 1;
      break;
    }
    const lines = JSON.parse(readFileSync(file, "utf8")) as string[];
    shots.push({ caption: spec.caption, lines, from: COLUMNS - SIDEBAR, width: SIDEBAR, look: lookOf(themeJson) });
  }
  try {
    if (!process.exitCode) save("context-states", shots, 3);
    if (!process.exitCode) writeImages();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

// ---- Pi, as `pi -e ./src/index.ts` starts it, in the virtual terminal ----

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir: dir, sessionManager, sessionStartEvent }) => {
  const services = await pi.createAgentSessionServices({
    cwd,
    agentDir: dir,
    resourceLoaderOptions: {
      additionalExtensionPaths: [join(root, "src", "index.ts")],
      extensionFactories: [{ name: "screenshots", factory: helper, hidden: true }],
      // MCP would try to start servers; the screenshots need none.
      disabledBuiltinExtensions: ["mcp"],
    },
  });
  const model = services.modelRuntime.getModel("anthropic", MODEL_ID);
  if (!model) throw new Error("the scripted model is not registered");
  const created = await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "medium" });
  return { ...created, services, diagnostics: services.diagnostics };
};
const sessionManager = pi.SessionManager.create(project);
sessionManager.appendSessionInfo("git-panel-refresh");
const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd: project, agentDir, sessionManager });
pi.initTheme(themeName, false);
const interactive = new pi.InteractiveMode(runtime, { tuiMode: "fullscreen", terminal, initialThemeSetting: themeName });
void interactive.run().catch((error: unknown) => {
  console.error("pi stopped:", error);
  process.exitCode = 1;
});

const look = lookOf(themeJson);
const sidebar = (lines: string[], columns = terminal.columns): Shot => ({ lines, from: columns - SIDEBAR, width: SIDEBAR, look });
const whole = (lines: string[]): Shot => ({ lines, from: 0, width: terminal.columns, look });
const run = async <T>(what: string, step: () => Promise<T>): Promise<T> => {
  process.stdout.write(`${what} … `);
  const value = await step();
  console.log("ok");
  return value;
};

try {
  await run("start Pi", () => until("the sidebar", has("SESSION")));

  if (state) {
    // One exchange is enough: the model's window is what makes the state.
    await enter(STATE_PROMPT);
    await until("the run to start", has("WORKING"), 20_000);
    const answered = await run("the reply", () => until("the answer", has("READY"), 60_000));
    if (!stateOut) throw new Error("--state needs --state-out");
    writeFileSync(stateOut, JSON.stringify(contextBlock(answered)), "utf8");
    throw captured;
  }

  // A run: two reads, a command that takes a while, then an edit and a new file.
  await enter("How does the GIT panel decide when to refresh? Add a short note about it.");
  await run("a run in progress", () => until("the running command", has("▶ bash"), 30_000));
  await sleep(1_000);
  const working = await frame();
  await run("the finished run", () => until("the answer", (lines) => has("Last run")(lines) && has("notes/git-panel.md")(lines), 60_000));
  // The GIT panel refreshes 500 ms after the agent settles.
  const idle = await run("git refresh", () => until("the changed files", has("2 files"), 10_000));
  save("pi-fullscreen", [whole(idle)]);
  save("sidebar-running", [sidebar(working)]);

  // The narrow style: 28 columns in a terminal 96 wide.
  terminal.resize(NARROW_COLUMNS);
  const narrow = await run("width 28", () => until("the narrow sidebar", (lines) => has("│ ✦ SESSION")(lines)));
  save("pi-narrow", [whole(narrow)]);
  terminal.resize(COLUMNS);
  await until("the wide sidebar", has("╭─ ✦ SESSION"));

  // Clicks: fold two panels, open the recent tools and the tool names.
  await click("USAGE");
  await click("CONTEXT");
  await click("… 2 more");
  await click("▸ names");
  const clicked = await run("clicks", () => until("the folded panels", (lines) => has("▸ USAGE")(lines) && has("▾ names")(lines)));
  save("sidebar-clicks", [
    { ...sidebar(idle), caption: "after the run" },
    { ...sidebar(clicked), caption: "CONTEXT, USAGE folded; lists opened" },
  ]);
} catch (error) {
  if (error !== captured) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  interactive.stop();
}
try {
  if (!process.exitCode && !state) writeImages();
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
