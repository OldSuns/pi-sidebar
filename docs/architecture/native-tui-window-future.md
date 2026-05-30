# Future: Native Pi TUI Window Regions

## Summary

The sidebar currently ships as an overlay-based plugin. That is the right scope for this package because it works with pi's existing extension APIs and avoids forking pi.

A fully native sidebar should be a future pi core feature: first-class TUI window/region management that reserves terminal columns for side panels and asks the transcript, editor, footer, and overlays to render within the remaining main region.

## Why native window management is needed

The plugin can draw a convincing full-height right window, but pi still lays out the main interface as if it owns the full terminal width. The sidebar covers the right edge visually; it does not change the wrapping width of chat messages, tool output, the editor, or the footer.

Native support would provide:

- true reserved columns for right/left side regions;
- main transcript/editor/footer wrapping before the sidebar;
- footer/status components that can be moved into sidebar regions;
- proper terminal resize behavior;
- collision-aware overlay placement;
- reusable infrastructure for other plugins.

## Desired core primitive

A possible internal model:

```ts
type TuiRegion = {
  id: string;
  side: "left" | "right";
  width: number;
  gap?: number;
  minTerminalWidth?: number;
  priority?: number;
  render(width: number, height: number): string[];
};
```

A possible extension API:

```ts
ctx.ui.setSidebar("git", componentFactory, {
  side: "right",
  width: 34,
  gap: 1,
  minTerminalWidth: 110,
});

ctx.ui.setStatus("model", text, { placement: "sidebar" });
ctx.ui.setWidget("context", renderer, { placement: "sidebar" });
```

## Migration path from this plugin

1. Keep this overlay implementation as the stable package behavior.
2. Add feature detection when pi exposes native sidebar/window APIs.
3. Prefer the native API when available.
4. Fall back to overlay mode for older pi versions or narrow terminals.
5. Remove filler-row behavior when the native renderer provides real height.

## Work required in pi core

1. Add a layout model that computes `mainWidth`, `sidebarWidth`, and `gap` from registered regions.
2. Render transcript/history with `mainWidth` rather than terminal width.
3. Render editor/input with `mainWidth`.
4. Render footer/status with `mainWidth`, while allowing some items to target sidebar placement.
5. Render side regions into reserved columns.
6. Update overlay placement to understand reserved regions.
7. Add resize handling and tests for narrow terminal collapse/fallback.
8. Expose extension APIs and document lifecycle/disposal semantics.

## Open design questions

- Should pi support only one sidebar or multiple named side regions?
- Should sidebars be ordered by priority, registration order, or explicit slots?
- Should sidebar width be fixed, percentage-based, or content-measured?
- What is the collapse behavior on narrow terminals: hide, float, or replace footer?
- How should keyboard focus work for interactive future sidebars?
- Should footer relocation be automatic or opt-in per footer/status/widget item?

## Recommendation

Do not fork pi yet for this package. Treat the overlay sidebar as the commit-ready implementation and keep this document as the handoff/spec for a future pi core contribution.
