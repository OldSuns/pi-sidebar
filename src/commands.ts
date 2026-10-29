import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { BODY_PANELS, type BodyPanel, type ColorMode, type IconMode, LIMITS, PANEL_NAMES, type PanelName, type SidebarConfig } from "./config.ts";
import type { WidthSetting } from "./layout/width.ts";
import { errorText } from "./util.ts";

/** What `/sidebar` can do; implemented by the controller. Each method returns the line to show. */
export interface SidebarActions {
  readonly config: SidebarConfig;
  setEnabled(enabled: boolean): string;
  setWidth(width: WidthSetting): string;
  setMinMainWidth(columns: number): string;
  setPanel(panel: BodyPanel, on: boolean): string;
  setFold(panel: PanelName | "all", folded: boolean): string;
  setBreakdown(on: boolean): string;
  setGitFiles(count: number): string;
  setColors(colors: ColorMode): string;
  setIcons(icons: IconMode): string;
  reset(): string;
  statusText(): string;
  dumpScreen(): string;
}

export const USAGE =
  "Usage: /sidebar [on|off|toggle|status|reset] | width auto|28|36 | min-main <48-160> | panel <usage|activity|git|tools|workspace> on|off | fold|unfold <panel|all> | breakdown on|off | git on|off | git files <0-10> | colors theme|vivid|mono | icons unicode|ascii";

const item = (value: string, description: string): AutocompleteItem => ({ value, label: value, description });

/** Completions replace the whole argument text, so each value is a complete argument (UX-3). */
const COMPLETIONS: readonly AutocompleteItem[] = [
  item("on", "show the sidebar"),
  item("off", "remove the sidebar and give Pi its layout back"),
  item("toggle", "switch the sidebar on or off"),
  item("status", "mount state, width decision, git, errors"),
  item("width auto", "36 or 28 columns, hidden when the main area would get too narrow"),
  item("width 28", "always 28 columns (title rules)"),
  item("width 36", "always 36 columns (boxed panels)"),
  item("min-main 64", "narrowest main area the sidebar may leave (48-160)"),
  ...BODY_PANELS.flatMap((panel) => [
    item(`panel ${panel} on`, `show the ${panel.toUpperCase()} panel`),
    item(`panel ${panel} off`, `hide the ${panel.toUpperCase()} panel`),
  ]),
  ...PANEL_NAMES.map((panel) => item(`fold ${panel}`, `fold ${panel.toUpperCase()} to its title line (or click the title)`)),
  ...PANEL_NAMES.map((panel) => item(`unfold ${panel}`, `unfold ${panel.toUpperCase()}`)),
  item("fold all", "fold every panel"),
  item("unfold all", "unfold every panel"),
  item("breakdown on", "show the estimated context breakdown under the CONTEXT bar"),
  item("breakdown off", "hide the context breakdown"),
  item("git on", "show the GIT panel"),
  item("git off", "hide the GIT panel; no git processes are started"),
  item("git files 3", "changed files listed at width 36 (0-10)"),
  item("colors theme", "panel colours from the current theme"),
  item("colors vivid", "fixed vivid panel colours"),
  item("colors mono", "no panel colours"),
  item("icons unicode", "symbols and box drawing"),
  item("icons ascii", "plain ASCII, for terminals that draw some symbols double-width"),
  item("reset", "restore the default settings"),
  item("dump", "write the current screen to a temp file (debugging)"),
];

export function completions(prefix: string): AutocompleteItem[] | null {
  const typed = prefix.trimStart().toLowerCase().replace(/\s+/g, " ");
  const items = COMPLETIONS.filter((candidate) => candidate.value.startsWith(typed));
  return items.length > 0 ? [...items] : null;
}

export interface CommandResult {
  text: string;
  level: "info" | "warning" | "error";
}

export function registerSidebarCommand(pi: ExtensionAPI, actions: SidebarActions): void {
  pi.registerCommand("sidebar", {
    description: "Session sidebar for fullscreen mode: on, off, width, panels, fold, colors, status",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const result = runSidebarCommand(actions, args);
      ctx.ui.notify(result.text, result.level);
    },
  });
}

/** Parse and apply one `/sidebar` invocation; invalid input changes nothing (UX-4). */
export function runSidebarCommand(actions: SidebarActions, args: string): CommandResult {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [verb = "toggle", first, second] = words;
  const info = (text: string): CommandResult => ({ text, level: "info" });
  const invalid = (problem: string): CommandResult => ({ text: `sidebar: ${problem}. ${USAGE}`, level: "warning" });
  try {
    switch (verb) {
      case "toggle":
      case "on":
      case "off":
      case "status":
      case "reset":
      case "dump":
        if (words.length > 1) return invalid(`"${verb}" takes no value`);
        if (verb === "status") return info(actions.statusText());
        if (verb === "reset") return info(actions.reset());
        if (verb === "dump") return info(actions.dumpScreen());
        return info(actions.setEnabled(verb === "toggle" ? !actions.config.enabled : verb === "on"));
      case "width":
        if (words.length === 2 && first === "auto") return info(actions.setWidth("auto"));
        if (words.length === 2 && (first === "28" || first === "36")) return info(actions.setWidth(first === "28" ? 28 : 36));
        return invalid("width must be auto, 28 or 36");
      case "min-main": {
        const columns = wholeNumber(first);
        const { min, max } = LIMITS.minMainWidth;
        if (words.length === 2 && columns !== undefined && columns >= min && columns <= max) return info(actions.setMinMainWidth(columns));
        return invalid(`min-main must be a whole number from ${min} to ${max}`);
      }
      case "panel": {
        const panel = BODY_PANELS.find((name) => name === first);
        if (words.length === 3 && panel && (second === "on" || second === "off")) return info(actions.setPanel(panel, second === "on"));
        return invalid(`panel takes a name (${BODY_PANELS.join(", ")}) and on or off`);
      }
      case "fold":
      case "unfold": {
        const panel = first === "all" ? "all" : PANEL_NAMES.find((name) => name === first);
        if (words.length === 2 && panel) return info(actions.setFold(panel, verb === "fold"));
        return invalid(`${verb} takes a panel name (${PANEL_NAMES.join(", ")}) or all`);
      }
      case "breakdown":
        if (words.length === 2 && (first === "on" || first === "off")) return info(actions.setBreakdown(first === "on"));
        return invalid("breakdown takes on or off");
      case "git": {
        if (words.length === 2 && (first === "on" || first === "off")) return info(actions.setPanel("git", first === "on"));
        const count = wholeNumber(second);
        const { min, max } = LIMITS.maxFiles;
        if (words.length === 3 && first === "files" && count !== undefined && count >= min && count <= max) {
          return info(actions.setGitFiles(count));
        }
        return invalid(`git takes on, off, or files <${min}-${max}>`);
      }
      case "colors":
        if (words.length === 2 && (first === "theme" || first === "vivid" || first === "mono")) return info(actions.setColors(first));
        return invalid("colors must be theme, vivid or mono");
      case "icons":
        if (words.length === 2 && (first === "unicode" || first === "ascii")) return info(actions.setIcons(first));
        return invalid("icons must be unicode or ascii");
      default:
        return invalid(`unknown option "${verb}"`);
    }
  } catch (error) {
    return { text: `sidebar: ${errorText(error)}`, level: "error" };
  }
}

function wholeNumber(text: string | undefined): number | undefined {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
}
