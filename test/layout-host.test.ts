import assert from "node:assert/strict";
import { test } from "node:test";
import { type Component, HStack, stripTerminalSequences, VStack } from "@earendil-works/pi-tui";
import { getScrollViewsAt, type LayoutBox, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { defaultConfig } from "../src/config.ts";
import { type LayoutEvents, LayoutHost, type LayoutPort, type LayoutSettings } from "../src/host/layout-host.ts";
import { Palette } from "../src/ui/palette.ts";
import { SidebarFrame, type SidebarModel } from "../src/ui/sidebar.ts";
import { fakeTheme, sampleSnapshot, testView } from "./helpers.ts";

const text = (label: string): Component => ({ render: (width) => [label.padEnd(width).slice(0, width)], invalidate() {} });

/** A fullscreen renderer whose root the test controls. */
function fakePort(initial: unknown, size = { columns: 120, rows: 40 }) {
  let root = initial;
  const port = {
    sets: 0,
    renders: 0,
    fullscreen: true,
    mode: () => (port.fullscreen ? "fullscreen" : "regular"),
    isFullscreen: () => port.fullscreen,
    root: () => root,
    replace(next: unknown) {
      root = next;
    },
    size: () => size,
  };
  const layoutPort: LayoutPort = {
    mode: port.mode,
    fullscreen: () => port.fullscreen,
    root: () => root,
    setRoot: (component) => {
      root = component;
      port.sets++;
    },
    requestRender: () => {
      port.renders++;
    },
    size: () => size,
    screenLines: () => undefined,
  };
  return { port, layoutPort };
}

function setup(settings: Partial<LayoutSettings> = {}) {
  const config = { ...defaultConfig(), ...settings };
  const failures: string[] = [];
  const errors: string[] = [];
  const widths: number[] = [];
  const palette = new Palette(fakeTheme(), "theme");
  const model: SidebarModel = {
    snapshot: sampleSnapshot(),
    view: () => testView(),
    palette: () => palette,
    rows: () => 40,
    renderKey: () => "key",
    invalidate() {},
    reportError: (where, error) => errors.push(`${where}: ${String(error)}`),
    act() {},
  };
  const current: LayoutSettings = { enabled: config.enabled, width: config.width, minMainWidth: config.minMainWidth, icons: config.icons };
  const events: LayoutEvents = {
    settings: () => current,
    widthChanged: (width) => widths.push(width),
    failed: (reason) => failures.push(reason),
    reportError: (where, error) => errors.push(`${where}: ${String(error)}`),
  };
  return { host: new LayoutHost(model, events), settings: current as { -readonly [K in keyof LayoutSettings]: LayoutSettings[K] }, failures, errors, widths };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Lay out one frame like Pi does and return the main area's width. */
function frame(root: unknown, columns: number, rows = 40): number {
  const laidOut = renderLayoutFrame(root as Component, columns, rows, () => {});
  return laidOut.root.children[0]?.rect.width ?? 0;
}

test("mounting keeps Pi's root unchanged in the left cell; detaching puts it back", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const { host, errors } = setup();
  host.attach(layoutPort);
  await flush();
  const root = port.root();
  assert.ok(root instanceof HStack);
  assert.notEqual(root, base);
  const laidOut = renderLayoutFrame(root, 120, 40, () => {});
  assert.equal(laidOut.root.children[0]?.component, base);
  assert.equal(laidOut.root.children[0]?.rect.width, 84);
  assert.equal(host.info().width, 36);
  assert.equal(host.info().state, "mounted");
  host.detach();
  assert.equal(port.root(), base);
  assert.deepEqual(errors, []);
});

test("terminal width decides 36, 28 or hidden, with hysteresis, and the main area gets the rest", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const { host, widths } = setup();
  host.attach(layoutPort);
  await flush();
  const root = port.root();
  const steps: [number, number][] = [
    [120, 84],
    [100, 64],
    [99, 71],
    [92, 64],
    [91, 91],
    [80, 80],
    [95, 95],
    [96, 68],
    [103, 75],
    [104, 68],
  ];
  for (const [columns, main] of steps) assert.equal(frame(root, columns), main, `terminal ${columns}`);
  assert.deepEqual(widths, [36, 28, 0, 28, 36]);
});

test("Pi re-setting its root (a mode switch) is wrapped again without counting as a conflict", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const { host } = setup();
  host.attach(layoutPort);
  await flush();
  port.replace(base);
  host.onProbeRender();
  await flush();
  assert.notEqual(port.root(), base);
  assert.equal(host.stats.remounts, 1);
  assert.equal(host.stats.conflicts, 0);
  assert.equal(host.info().state, "mounted");
});

test("leaving fullscreen goes inactive; coming back mounts again", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const { host } = setup();
  host.attach(layoutPort);
  await flush();
  port.fullscreen = false;
  host.onProbeRender();
  await flush();
  assert.equal(host.info().state, "inactive");
  port.fullscreen = true;
  port.replace(base);
  host.onProbeRender();
  await flush();
  assert.equal(host.info().state, "mounted");
  assert.notEqual(port.root(), base);
});

test("/sidebar off restores the root; on wraps it again", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const { host, settings } = setup();
  host.attach(layoutPort);
  await flush();
  settings.enabled = false;
  host.refresh();
  await flush();
  assert.equal(port.root(), base);
  assert.equal(host.info().state, "disabled");
  settings.enabled = true;
  host.refresh();
  await flush();
  assert.notEqual(port.root(), base);
  assert.equal(host.info().state, "mounted");
});

test("an extension that keeps replacing the root makes the host give up once", async () => {
  const { port, layoutPort } = fakePort(new VStack([text("first")]));
  const { host, failures } = setup();
  host.attach(layoutPort);
  await flush();
  for (let round = 0; round < 6; round++) {
    port.replace(new VStack([text(`other ${round}`)]));
    host.onProbeRender();
    await flush();
  }
  assert.equal(host.info().state, "failed");
  assert.equal(failures.length, 1);
  assert.equal(host.stats.remounts, 5);
});

test("being wrapped by another extension leaves the layout alone", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const { host } = setup();
  host.attach(layoutPort);
  await flush();
  const ours = port.root() as Component;
  const outer = new HStack([{ component: ours, grow: 1, basis: 0 }, { component: text("other"), basis: 10 }]);
  port.replace(outer);
  host.onProbeRender();
  await flush();
  assert.equal(port.root(), outer);
  assert.equal(port.sets, 1);
  assert.equal(host.info().nested, true);
});

test("a wrapper left by an earlier runtime is replaced, not wrapped again", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const first = setup().host;
  first.attach(layoutPort);
  await flush();
  const stale = port.root();
  const second = setup().host;
  second.attach(layoutPort);
  await flush();
  const laidOut = renderLayoutFrame(port.root() as Component, 120, 40, () => {});
  assert.notEqual(port.root(), stale);
  assert.equal(laidOut.root.children[0]?.component, base);
});

test("an unknown root shape fails closed and leaves Pi's root alone", async () => {
  const odd = { render: () => ["odd"], invalidate() {} };
  const { port, layoutPort } = fakePort(odd);
  const { host, failures } = setup();
  host.attach(layoutPort);
  await flush();
  assert.equal(port.root(), odd);
  assert.equal(host.info().state, "failed");
  assert.match(failures[0] ?? "", /unexpected layout root/);
});

test("a low terminal still renders without errors", async () => {
  const base = new VStack([text("transcript")]);
  const { port, layoutPort } = fakePort(base);
  const { host, errors } = setup();
  host.attach(layoutPort);
  await flush();
  for (const rows of [40, 20, 8]) {
    const laidOut = renderLayoutFrame(port.root() as Component, 120, rows, () => {});
    assert.equal(laidOut.lines.length, rows);
  }
  assert.deepEqual(errors, []);
});

/** Boxes that paint a line on row `y`. */
function paintersAt(box: LayoutBox, y: number): number {
  let count = 0;
  const inside = y >= box.rect.y && y < box.rect.y + box.rect.height && y >= box.clip.y && y < box.clip.y + box.clip.height;
  if (box.lines && inside && box.lines[(box.lineOffset ?? 0) + y - box.rect.y] !== undefined) count++;
  for (const child of box.children) count += paintersAt(child, y);
  return count;
}

test("one box paints each sidebar row (PERF-6); the 28-column rule runs the full height; no wheel reaches the transcript", () => {
  const palette = new Palette(fakeTheme(), "theme");
  const folded = testView({ folded: new Set(["usage", "activity", "git", "tools", "workspace"] as const) });
  for (const [tier, width] of [
    ["compact", 28],
    ["normal", 36],
  ] as const) {
    for (const view of [testView(), folded]) {
      const model: SidebarModel = {
        snapshot: sampleSnapshot(),
        view: () => view,
        palette: () => palette,
        rows: () => 40,
        renderKey: () => "key",
        invalidate() {},
        reportError: (_where, error) => assert.fail(String(error)),
        act() {},
      };
      const frame = renderLayoutFrame(new SidebarFrame(model, tier), width, 40, () => {});
      const lines = frame.lines.map((line) => stripTerminalSequences(line));
      const label = `${tier}, ${view === folded ? "short" : "long"} content`;
      assert.ok(lines.some((line) => line.includes("CONTEXT")), label);
      for (let y = 0; y < 40; y++) {
        assert.ok(paintersAt(frame.root, y) <= 1, `${label}: row ${y} is painted twice`);
        if (tier === "compact") assert.ok(lines[y]?.startsWith("│ "), `${label}: row ${y} is "${lines[y]}"`);
        else if (lines[y] !== "") assert.ok(lines[y]?.startsWith(" "), `${label}: row ${y} is "${lines[y]}"`);
        // Every cell of the sidebar is over a scroll view that keeps the whole wheel delta.
        for (const x of [0, width - 1]) {
          const views = getScrollViewsAt(frame, x, y);
          assert.ok(views.length > 0, `${label}: the wheel at ${x},${y} would reach the transcript`);
          for (const scrollView of views) assert.equal(scrollView.scrollBy(1), 0, label);
        }
      }
    }
  }
});
