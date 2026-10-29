import type { SidebarSnapshot } from "./snapshot.ts";

export type SnapshotChange = Partial<Omit<SidebarSnapshot, "version" | "clock">>;

/** Holds the snapshot the sidebar draws (R-2). Every change bumps the version and the clock, then asks for a render. */
export class SnapshotStore {
  snapshot: SidebarSnapshot;
  private readonly changed: () => void;

  constructor(initial: SidebarSnapshot, changed: () => void) {
    this.snapshot = initial;
    this.changed = changed;
  }

  replace(next: SidebarSnapshot): void {
    this.snapshot = { ...next, version: this.snapshot.version + 1 };
    this.changed();
  }

  update(change: (current: SidebarSnapshot) => SnapshotChange, now = Date.now()): void {
    const current = this.snapshot;
    this.snapshot = { ...current, ...change(current), version: current.version + 1, clock: now };
    this.changed();
  }
}

/** Coalesces render requests: at most one per `interval()` ms while the agent works, the next tick otherwise (D-8). */
export class RenderScheduler {
  private readonly request: () => void;
  private readonly busy: () => boolean;
  private readonly interval: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = 0;

  constructor(request: () => void, busy: () => boolean, interval: () => number) {
    this.request = request;
    this.busy = busy;
    this.interval = interval;
  }

  schedule(): void {
    if (this.timer !== undefined) return;
    const wait = this.busy() ? Math.max(0, this.last + this.interval() - Date.now()) : 0;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.last = Date.now();
      this.request();
    }, wait);
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
