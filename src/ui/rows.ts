import type { PanelName } from "../config.ts";
import type { Line } from "./text.ts";

/** Sections that a click opens and closes. `breakdown` is saved in the config, the others last the session. */
export type ToggleKey = "breakdown" | "gitFiles" | "recentTools" | "toolNames";

/** What a click on a row does. */
export type Action = { readonly type: "fold"; readonly panel: PanelName } | { readonly type: "toggle"; readonly key: ToggleKey };

/** One sidebar line and what clicking it does, if anything. */
export interface Row {
  readonly segs: Line;
  readonly action?: Action;
}

export function row(segs: Line, action?: Action): Row {
  return action ? { segs, action } : { segs };
}

export const foldAction = (panel: PanelName): Action => ({ type: "fold", panel });
export const toggleAction = (key: ToggleKey): Action => ({ type: "toggle", key });
