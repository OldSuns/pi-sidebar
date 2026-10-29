import { type Component, HStack, isViewportTUI, ScrollView, type TUI, VStack } from "@earendil-works/pi-tui";
import type { IconMode } from "../config.ts";
import { pickWidth, type SidebarWidth, type WidthSetting } from "../layout/width.ts";
import { SidebarFrame, type SidebarModel } from "../ui/sidebar.ts";
import { errorText } from "../util.ts";
import { HostProbe, type ProbeListener } from "./host-probe.ts";

/** Shared across module instances, so a wrapper left behind by an earlier runtime is still recognised. */
const OWNER = Symbol.for("@oldsuns/pi-sidebar:owner");
const ORIGINAL = Symbol.for("@oldsuns/pi-sidebar:original");
/** More foreign root replacements than this within the window: another extension fights over the root (HOST-5). */
const MAX_CONFLICTS = 5;
const CONFLICT_WINDOW_MS = 60_000;
/** Stack.render() outside a layout frame reports an unbounded height; the sidebar never draws there. */
const MAX_LAYOUT_ROWS = 10_000;

type SidebarRoot = HStack & { [OWNER]?: string; [ORIGINAL]?: Component };

/** The renderer as the layout host sees it. `tuiPort()` adapts Pi's TUI; tests pass a fake. */
export interface LayoutPort {
  mode(): string;
  /** A viewport renderer in fullscreen mode, the only one with a layout root. */
  fullscreen(): boolean;
  root(): unknown;
  setRoot(component: Component): void;
  requestRender(): void;
  size(): { columns: number; rows: number };
  screenLines(): string[] | undefined;
}

export function tuiPort(tui: TUI): LayoutPort {
  const viewport = () => (isViewportTUI(tui) && tui.mode === "fullscreen" ? tui : undefined);
  return {
    mode: () => tui.mode,
    fullscreen: () => viewport() !== undefined,
    // The single private read (HOST-1); through Pi's stable TUI proxy it reaches the current renderer.
    root: () => (viewport() as unknown as { layoutRoot?: unknown } | undefined)?.layoutRoot,
    setRoot: (component) => viewport()?.setLayoutRoot(component),
    requestRender: () => tui.requestRender(),
    size: () => ({ columns: tui.terminal.columns, rows: tui.terminal.rows }),
    screenLines: () => (tui as TUI & { getScreenLines?: () => string[] }).getScreenLines?.(),
  };
}

export interface LayoutSettings {
  readonly enabled: boolean;
  readonly width: WidthSetting;
  readonly minMainWidth: number;
  readonly icons: IconMode;
}

export interface LayoutEvents {
  settings(): LayoutSettings;
  /** Called while Pi lays out a frame: record the width, defer any work. */
  widthChanged(width: 0 | SidebarWidth): void;
  failed(reason: string): void;
  reportError(where: string, error: unknown): void;
}

export type HostState = "idle" | "probing" | "mounted" | "inactive" | "disabled" | "failed";

export interface LayoutInfo {
  state: HostState;
  failure?: string;
  mode: string;
  width: 0 | SidebarWidth;
  columns: number;
  rows: number;
  wrapped: boolean;
  nested: boolean;
  stats: Readonly<LayoutHost["stats"]>;
}

let instances = 0;

/**
 * Puts the sidebar beside Pi's fullscreen layout (design §3.2): Pi's layout root goes unchanged into the
 * left cell of an HStack whose other cells are the 36- and 28-column sidebars.
 */
export class LayoutHost implements ProbeListener {
  readonly instanceId = `${Date.now().toString(36)}.${(instances++).toString(36)}`;
  state: HostState = "idle";
  failure?: string;
  readonly stats = { probeFrames: 0, syncs: 0, mounts: 0, remounts: 0, conflicts: 0, widthChanges: 0 };

  private readonly events: LayoutEvents;
  private readonly frames: { readonly normal: SidebarFrame; readonly compact: SidebarFrame };
  private port?: LayoutPort;
  private probe?: HostProbe;
  /** The HStack we mounted. Clearing it retires the wrapper: a retired wrapper draws no sidebar. */
  private wrapper?: SidebarRoot;
  /** The root we last wrapped; Pi puts this same object back when it returns to fullscreen. */
  private lastBase?: Component;
  private nested = false;
  /** Width shown in the last layout frame, 0 while hidden. */
  private width: 0 | SidebarWidth = 0;
  private viewport = { width: 0, height: 0 };
  private observedRoot: unknown = null;
  private observedEnabled = true;
  private syncQueued = false;
  private conflictTimes: number[] = [];

  constructor(model: SidebarModel, events: LayoutEvents) {
    this.events = events;
    this.frames = { normal: new SidebarFrame(model, "normal"), compact: new SidebarFrame(model, "compact") };
  }

  /** The probe widget's factory hands over Pi's renderer (design §3.2-1). */
  attach(port: LayoutPort): HostProbe {
    this.detach();
    this.port = port;
    this.state = "probing";
    this.failure = undefined;
    const probe = new HostProbe(this);
    this.probe = probe;
    this.configure();
    this.scheduleSync();
    return probe;
  }

  /** Give Pi its layout back and forget the renderer (LIFE-3). */
  detach(): void {
    const port = this.port;
    if (port) {
      try {
        this.restore(port);
      } catch (error) {
        this.events.reportError("unmount", error);
      }
    }
    this.port = undefined;
    this.probe = undefined;
    this.wrapper = undefined;
    this.lastBase = undefined;
    this.nested = false;
    this.observedRoot = null;
    this.conflictTimes = [];
    this.setWidth(0);
    this.state = "idle";
  }

  /** Settings changed: re-check the layout and redraw. */
  refresh(): void {
    this.configure();
    this.scheduleSync();
    this.requestRender();
  }

  /** `/sidebar on` after a failure tries again. */
  retry(): void {
    if (this.state !== "failed") return;
    this.state = this.port ? "probing" : "idle";
    this.failure = undefined;
    this.conflictTimes = [];
  }

  requestRender(): void {
    try {
      this.port?.requestRender();
    } catch (error) {
      this.events.reportError("request render", error);
    }
  }

  rows(): number {
    return this.viewport.height > 0 ? this.viewport.height : (this.port?.size().rows ?? 24);
  }

  info(): LayoutInfo {
    const size = this.port?.size();
    return {
      state: this.state,
      failure: this.failure,
      mode: this.port ? (this.port.fullscreen() ? "fullscreen" : this.port.mode()) : "no tui",
      width: this.width,
      columns: this.viewport.width || size?.columns || 0,
      rows: this.viewport.height || size?.rows || 0,
      wrapped: this.wrapper !== undefined,
      nested: this.nested,
      stats: { ...this.stats },
    };
  }

  screenLines(): string[] | undefined {
    return this.port?.screenLines();
  }

  // ---- ProbeListener ----

  onProbeRender(): void {
    this.stats.probeFrames++;
    const port = this.port;
    if (!port || this.syncQueued || this.state === "failed") return;
    try {
      const root = port.fullscreen() ? port.root() : null;
      if (root !== this.observedRoot || this.events.settings().enabled !== this.observedEnabled) this.scheduleSync();
    } catch (error) {
      this.events.reportError("probe", error);
    }
  }

  onProbeDisposed(probe: HostProbe): void {
    // Pi clears extension widgets before it replaces a session; without the probe the root goes unwatched.
    if (probe === this.probe) this.detach();
  }

  // ---- layout ----

  private configure(): void {
    const { icons } = this.events.settings();
    this.frames.normal.configure(icons);
    this.frames.compact.configure(icons);
  }

  /** Layout changes never happen inside a render (HOST-4): the probe only notices, a microtask acts. */
  private scheduleSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => this.sync());
  }

  private sync(): void {
    this.syncQueued = false;
    const port = this.port;
    if (!port || this.state === "failed") return;
    this.stats.syncs++;
    try {
      this.syncLayout(port);
    } catch (error) {
      this.fail(`layout update failed: ${errorText(error)}`);
    }
    try {
      this.observedRoot = port.fullscreen() ? port.root() : null;
    } catch {
      this.observedRoot = null;
    }
    this.observedEnabled = this.events.settings().enabled;
  }

  private syncLayout(port: LayoutPort): void {
    const settings = this.events.settings();
    if (!port.fullscreen()) {
      // Leaving fullscreen drops the renderer and our wrapper with it (design §3.2-4).
      this.wrapper = undefined;
      this.setWidth(0);
      this.state = settings.enabled ? "inactive" : "disabled";
      return;
    }
    if (!settings.enabled) {
      this.restore(port);
      this.state = "disabled";
      return;
    }
    const root = port.root();
    if (root === undefined) {
      this.state = "probing";
      return;
    }
    // Pi's root is a pi-tui VStack; anything else means a changed layout or a second pi-tui copy (HOST-6).
    if (!(root instanceof VStack || root instanceof HStack)) {
      this.fail("unexpected layout root (not a pi-tui stack)");
      return;
    }
    if (this.wrapper && (root === this.wrapper || containsComponent(root, this.wrapper))) {
      this.nested = root !== this.wrapper;
      this.state = "mounted";
      return;
    }
    const base = unwrapStale(root);
    if (this.lastBase !== undefined && base !== this.lastBase && this.noteConflict()) {
      this.fail("the layout root keeps being replaced (another extension wraps it too)");
      return;
    }
    const wrapper = this.createRoot(base);
    // Set before setRoot so that the first frame of the new root already sees it as current.
    this.wrapper = wrapper;
    this.state = "mounted";
    port.setRoot(wrapper);
    if (this.lastBase === undefined) this.stats.mounts++;
    else this.stats.remounts++;
    this.lastBase = base;
    this.nested = false;
  }

  /**
   * Pi's root, unchanged, plus both sidebar widths. The layout engine asks each entry's `visible()` with
   * the terminal size every frame, so switching between 36, 28 and hidden needs no layout change.
   */
  private createRoot(base: Component): SidebarRoot {
    const root: SidebarRoot = new HStack([
      // No minSize: when the sidebar hides, the main area must get exactly the terminal width (MAIN-1).
      { component: base, basis: 0, grow: 1, shrink: 1 },
      { component: this.frames.normal, basis: 36, grow: 0, shrink: 0, visible: (viewport) => this.decideWidth(viewport, root) === 36 },
      { component: this.frames.compact, basis: 28, grow: 0, shrink: 0, visible: (viewport) => this.decideWidth(viewport, root) === 28 },
    ]);
    root[OWNER] = this.instanceId;
    root[ORIGINAL] = base;
    return root;
  }

  private decideWidth(viewport: { width: number; height: number }, root: SidebarRoot): 0 | SidebarWidth {
    if (root !== this.wrapper || this.state !== "mounted") return 0;
    if (viewport.height >= MAX_LAYOUT_ROWS) return 0;
    this.viewport = { width: viewport.width, height: viewport.height };
    const settings = this.events.settings();
    const next = pickWidth(viewport.width, this.width, settings.width, settings.minMainWidth);
    if (next !== this.width) this.stats.widthChanges++;
    this.setWidth(next);
    return next;
  }

  private setWidth(width: 0 | SidebarWidth): void {
    if (width === this.width) return;
    this.width = width;
    this.events.widthChanged(width);
  }

  /** Take our wrapper out (design §3.2-3); when someone else has wrapped it, it stays but draws nothing. */
  private restore(port: LayoutPort): void {
    const wrapper = this.wrapper;
    this.wrapper = undefined;
    this.setWidth(0);
    if (!wrapper) return;
    const original = wrapper[ORIGINAL];
    if (port.fullscreen() && port.root() === wrapper && original) port.setRoot(original);
    else port.requestRender();
  }

  /** Fail closed (HOST-6): restore Pi's root, stop, and say so once. */
  private fail(reason: string): void {
    this.failure = reason;
    this.events.reportError("host", reason);
    const port = this.port;
    if (port) {
      try {
        this.restore(port);
      } catch (error) {
        this.events.reportError("restore", error);
      }
    }
    this.state = "failed";
    this.events.failed(reason);
  }

  private noteConflict(): boolean {
    const now = Date.now();
    this.conflictTimes = this.conflictTimes.filter((time) => now - time < CONFLICT_WINDOW_MS);
    this.conflictTimes.push(now);
    this.stats.conflicts++;
    return this.conflictTimes.length > MAX_CONFLICTS;
  }
}

function isComponent(value: unknown): value is Component {
  return typeof value === "object" && value !== null && typeof (value as Component).render === "function";
}

/** A wrapper left at the root by an earlier runtime of this extension is replaced, not wrapped again. */
function unwrapStale(root: Component): Component {
  const candidate = root as SidebarRoot;
  const original = candidate[ORIGINAL];
  return candidate[OWNER] !== undefined && isComponent(original) ? original : root;
}

/** Is `target` inside `root`? Walks only pi-tui stacks and scroll views, a few levels deep. */
function containsComponent(root: Component, target: Component): boolean {
  const pending: { node: Component; depth: number }[] = [{ node: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 256) {
    const next = pending.pop();
    if (!next) break;
    visited++;
    if (next.node === target) return true;
    if (next.depth >= 6) continue;
    if (next.node instanceof HStack || next.node instanceof VStack || next.node instanceof ScrollView) {
      for (const child of next.node.children) pending.push({ node: child, depth: next.depth + 1 });
    }
  }
  return false;
}
