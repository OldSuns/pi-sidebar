import { type Component, HStack, ScrollView, type TuiMouseEvent, type TuiMouseEventResult, VStack } from "@earendil-works/pi-tui";
import { BODY_PANELS, type BodyPanel, type IconMode, type PanelName } from "../config.ts";
import type { SidebarSnapshot } from "../state/snapshot.ts";
import { box, foldedLine, section } from "./frame.ts";
import type { Palette, Role } from "./palette.ts";
import { buildPanel, contextBarLine, modelLine, type Panel, type PanelView, statusLine, type Tier } from "./panels.ts";
import { type Action, foldAction, type Row, row } from "./rows.ts";
import { fit, seg, truncatePlain } from "./text.ts";

/** Below this many rows the pinned SESSION and CONTEXT panels merge into one 3-line block (design §6.5). */
const LOW_HEIGHT_ROWS = 28;
/** Below this many rows only the pinned block is shown. */
const MIN_BODY_ROWS = 12;
const PINNED_PANELS: readonly PanelName[] = ["session", "context"];

export interface SidebarView extends PanelView {
  readonly panels: Readonly<Record<BodyPanel, boolean>>;
  readonly folded: ReadonlySet<PanelName>;
}

/** What the sidebar components read while rendering. Implemented by the controller. */
export interface SidebarModel {
  readonly snapshot: SidebarSnapshot;
  view(): SidebarView;
  palette(): Palette;
  /** Terminal rows of the current layout frame. */
  rows(): number;
  /** Changes whenever cached sidebar lines must be redrawn. */
  renderKey(): string;
  invalidate(): void;
  reportError(where: string, error: unknown): void;
  /** A click on a row that has an action. */
  act(action: Action): void;
}

/** One sidebar column: an edge, the pinned panels, and the scrolling panels below them. */
export class SidebarFrame extends HStack {
  private readonly body: SidebarScroll;
  private readonly tier: Tier;

  constructor(model: SidebarModel, tier: Tier) {
    const style = (role: Role) => (text: string) => {
      try {
        return model.palette().paint(seg(text, role));
      } catch {
        return text;
      }
    };
    // pi-tui composites every box narrower than the terminal into its row, parsing the whole row each
    // time. So each row of the sidebar is one box: the edge is part of every line, and below the panels
    // of the 28-column style a filler carries its rule on (design PERF-6).
    const body = new SidebarScroll(new PanelsView(model, tier, "body", true), {
      follow: "none",
      primary: false,
      scrollbar: "hidden",
      scrollbarTrackStyle: style("sep"),
      scrollbarThumbStyle: style("faint"),
    });
    // Parts that do not scroll still sit in a scroll view: it keeps the wheel over them from the transcript.
    const still = (component: Component) => new SidebarScroll(component, { follow: "none", primary: false, scrollbar: "hidden" });
    const header = still(new PanelsView(model, tier, "header", true));
    const visible = ({ height }: { height: number }) => height >= MIN_BODY_ROWS;
    const column =
      tier === "normal"
        ? new VStack([
            { component: header, basis: "auto", grow: 0, shrink: 1 },
            { component: body, basis: 0, grow: 1, shrink: 1, visible },
          ])
        : new VStack([
            { component: header, basis: "auto", grow: 0, shrink: 0 },
            { component: body, basis: "auto", grow: 0, shrink: 1, visible },
            // Identical lines: scrolling them shows no change.
            { component: still(new EdgeFiller(model)), basis: 0, grow: 1, shrink: 1 },
          ]);
    super([{ component: column, basis: 0, grow: 1, shrink: 1 }]);
    this.body = body;
    this.tier = tier;
  }

  /**
   * The transient scrollbar lands on the box border in the 36-column style; at 28 columns it would cover
   * text, and its glyphs are not ASCII.
   */
  configure(icons: IconMode): void {
    this.body.setScrollbar(icons === "unicode" && this.tier === "normal" ? "auto" : "hidden");
  }
}

/**
 * Sidebar parts scroll by themselves and swallow the whole wheel delta: Pi hands any delta a scroll
 * view leaves over, or a wheel over no scroll view at all, to the transcript, which must not move
 * under the sidebar (design §3.2-6, F9).
 */
class SidebarScroll extends ScrollView {
  override scrollBy(lines: number): number {
    super.scrollBy(lines);
    return 0;
  }
}

/** Columns left of the panels: "│ " in the 28-column style, a blank gap before the 36-column boxes. */
const EDGE_WIDTH: Readonly<Record<Tier, number>> = { compact: 2, normal: 1 };

function edgeCell(tier: Tier, palette: Palette, view: SidebarView): string {
  return tier === "compact" ? `${palette.paint(seg(view.g.edge, "sep"))} ` : " ";
}

/** The rule of the 28-column style below the panels, as many lines as the terminal has rows. */
class EdgeFiller implements Component {
  private readonly model: SidebarModel;
  private cacheKey?: string;
  private cache: string[] = [];

  constructor(model: SidebarModel) {
    this.model = model;
  }

  render(width: number): string[] {
    const rows = this.model.rows();
    const key = `${width}|${rows}|${this.model.renderKey()}`;
    if (key === this.cacheKey) return this.cache;
    try {
      const line = edgeCell("compact", this.model.palette(), this.model.view());
      this.cache = Array.from({ length: rows }, () => line);
    } catch (error) {
      this.model.reportError("render edge", error);
      this.cache = [];
    }
    this.cacheKey = key;
    return this.cache;
  }

  invalidate(): void {
    this.cacheKey = undefined;
  }
}

/**
 * Renders the pinned panels ("header") or the scrolling ones ("body"); never throws (R-6).
 * A left click on a row with an action runs it: panel titles fold, "… more" rows open lists. The press
 * is claimed only on such rows, so text selection works everywhere else, and keyboard focus never moves.
 */
export class PanelsView implements Component {
  private readonly model: SidebarModel;
  private readonly tier: Tier;
  private readonly part: "header" | "body";
  /** Lines start with the sidebar's edge (EDGE_WIDTH). */
  private readonly edge: boolean;
  private cacheKey?: string;
  private cache: string[] = [];
  private actions: (Action | undefined)[] = [];

  constructor(model: SidebarModel, tier: Tier, part: "header" | "body", edge = false) {
    this.model = model;
    this.tier = tier;
    this.part = part;
    this.edge = edge;
  }

  render(width: number): string[] {
    const low = this.part === "header" && this.model.rows() < LOW_HEIGHT_ROWS;
    const key = `${width}|${low}|${this.model.renderKey()}`;
    if (key === this.cacheKey) return this.cache;
    try {
      const palette = this.model.palette();
      const view = this.model.view();
      const snapshot = this.model.snapshot;
      const inner = this.edge ? Math.max(1, width - EDGE_WIDTH[this.tier]) : width;
      const rows = this.part === "header" ? headerRows(snapshot, view, this.tier, inner, low) : bodyRows(snapshot, view, this.tier, inner);
      const edge = this.edge ? edgeCell(this.tier, palette, view) : "";
      this.cache = rows.map((line) => edge + palette.paintLine(fit(line.segs, inner, view.g.ellipsis)));
      this.actions = rows.map((line) => line.action);
    } catch (error) {
      this.model.reportError(`render ${this.part}`, error);
      this.cache = [truncatePlain("sidebar error (see /sidebar status)", width)];
      this.actions = [];
    }
    this.cacheKey = key;
    return this.cache;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const action = this.actions[event.y];
    if (!action) return undefined;
    if (event.type === "press") return { handled: true, render: false };
    // A double click arrives as a second click; it must not undo the first.
    if ((event.clickCount ?? 1) === 1) this.model.act(action);
    return { handled: true, render: true };
  }

  invalidate(): void {
    this.cacheKey = undefined;
    this.model.invalidate();
  }
}

/** A panel as drawn: folded to one line, a box (36 columns) or a titled section (28 columns). */
function block(name: PanelName | undefined, panel: Panel, view: SidebarView, tier: Tier, width: number): Row[] {
  const fold = name === undefined ? undefined : foldAction(name);
  if (name !== undefined && fold && view.folded.has(name)) {
    return [foldedLine(panel.role, panel.shortTitle ?? panel.title, panel.summary, width, view.g, tier === "normal", fold)];
  }
  return tier === "compact"
    ? section(panel.role, panel.title, panel.rows, width, view.g, fold)
    : box(panel.role, panel.title, panel.rows, width, view.g, fold);
}

/** Content width inside one panel: the boxes of the 36-column style take 2 columns on each side. */
function innerWidth(tier: Tier, width: number): number {
  return tier === "compact" ? width : width - 4;
}

/** SESSION and CONTEXT, or one merged block when the terminal is low. Ends with a blank separator line. */
export function headerRows(snapshot: SidebarSnapshot, view: SidebarView, tier: Tier, width: number, low: boolean): Row[] {
  const inner = innerWidth(tier, width);
  if (low) {
    const merged: Panel = {
      role: "session",
      title: "SESSION",
      summary: "",
      rows: [statusLine(snapshot, view, inner), modelLine(snapshot, view, inner), contextBarLine(snapshot, view, tier, inner)].map((line) => row(line)),
    };
    return [...block(undefined, merged, view, tier, width), row([])];
  }
  return PINNED_PANELS.flatMap((name) => [...block(name, buildPanel(name, snapshot, view, tier, inner), view, tier, width), row([])]);
}

/** The panels below, in their fixed order, skipping those turned off with `/sidebar panel`. */
export function bodyRows(snapshot: SidebarSnapshot, view: SidebarView, tier: Tier, width: number): Row[] {
  const inner = innerWidth(tier, width);
  const out: Row[] = [];
  for (const name of BODY_PANELS) {
    if (!view.panels[name]) continue;
    if (out.length > 0) out.push(row([]));
    out.push(...block(name, buildPanel(name, snapshot, view, tier, inner), view, tier, width));
  }
  return out;
}
