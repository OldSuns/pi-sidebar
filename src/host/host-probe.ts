import type { Component } from "@earendil-works/pi-tui";

export interface ProbeListener {
  onProbeRender(): void;
  onProbeDisposed(probe: HostProbe): void;
}

/**
 * Zero-line widget below the editor (design §3.2-1). Its factory hands us Pi's TUI, and since Pi renders
 * it every frame it doubles as a watchdog for layout root resets. Below the editor Pi adds no spacer
 * line around widgets (F11), so the main window does not change.
 */
export class HostProbe implements Component {
  private readonly listener: ProbeListener;

  constructor(listener: ProbeListener) {
    this.listener = listener;
  }

  render(_width: number): string[] {
    this.listener.onProbeRender();
    return [];
  }

  invalidate(): void {}

  dispose(): void {
    this.listener.onProbeDisposed(this);
  }
}
