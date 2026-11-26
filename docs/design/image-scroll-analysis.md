# Image disappearance while scrolling beside the sidebar

Analysis date: 2026-11-26. Status: diagnosed; no runtime fix implemented or approved.

## Conclusion and constraints

Pi 1.6.1 loses the visible remainder of a Kitty image when its anchor scrolls above a narrow conversation viewport. The sidebar triggers the faulty layout path by reducing the conversation width. A separate composition defect drops sidebar text on the image's anchor row.

The user's final constraint is to change this plugin only, without replacing or wrapping Pi methods or modifying Pi prototypes. Keep the existing restrictions in [AGENTS.md](../../AGENTS.md) and the [design document](./pi-sidebar-design.md), especially MAIN-1/2/3/7 and HOST-1/2. No exception to these rules was approved.

The user prefers retaining both the sidebar and images. No complete plugin-only solution preserving both and Pi's native interactions has been validated. Automatically hiding the sidebar in image-containing sessions is an unapproved workaround, not an implemented or agreed fix. The current authorization covers this analysis document only.

## Confirmed failure mechanism

Pi's native `Image` emits the Kitty drawing command on the first row, followed by placeholder rows reserving the image's height. Once that first row scrolls above the viewport, the layout engine must emit a cropped drawing command for the remaining visible rows.

In Pi 1.6.1, `paintBox()` finds the image above the viewport and computes `cropped`, but writes it back only when the viewport starts at column zero and spans the terminal width:

```ts
if (box.rect.x === 0 && box.rect.width >= totalWidth)
    screen[box.rect.y] = cropped;
```

There is no narrow-column branch. With the sidebar visible, the conversation is 28 or 36 columns narrower than the terminal. The cropped image command is omitted; native redraw removes the previous placement, leaving the placeholder rows blank.

Separately, `compositeTuiLine()` immediately returns `baseLine` when it contains an image. The sidebar is painted after the conversation, so its text on that same row is discarded. Adding only the missing crop branch would not address this second defect.

Evidence locations in the installed `@earendil-works/pi-tui` 1.6.1 package:

| Location | Relevant behavior |
| --- | --- |
| `dist/components/image.js`, `Image.render()` | First-row Kitty command followed by placeholder rows |
| `dist/layout.js:223-279`, `paintBox()` | Bottom cropping and the full-width-only top-crop writeback |
| `dist/tui.js:182-185`, `compositeTuiLine()` | Image-bearing base rows bypass subsequent composition |
| `dist/tui-alt-screen.js:1460-1612`, `doRender()` | Layout, overlays, placement deletion, upload reuse, and terminal output |
| [src/host/layout-host.ts](../../src/host/layout-host.ts), `createRoot()` | Original Pi root placed unchanged in the left cell of an `HStack` |

Pi 1.6.1 already redraws Kitty image-bearing rows after other text rows and detects changes in image-covered rows. Proposing that existing ordering alone does not fix the omitted layout command. Image source rectangles and cursor placement are specified by the [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/#controlling-displayed-image-layout).

## Reproduction evidence

Observed environment: Pi 1.6.1, pi-sidebar 1.0.4, PowerShell 7, fullscreen mode, and the Herdr/Orca embedded terminal using Kitty graphics. Open TUI 0.4.7 and pi-better-render 0.5.0 were included in comparison runs. Standalone Windows Terminal behavior remains unverified.

The earlier complete-runtime probe used real `InteractiveMode`, an in-memory session, and a real `read` tool result from a PNG. It replayed fixed messages without a model request. The recorded reports were reread for this document; these full-runtime runs were not repeated during documentation.

Each sweep below contains 44 scroll positions. The report files also contain startup and manual-position records. Counts describe deterministic positions, not random failure rates.

| Extensions | Sweep positions missing an expected image | Positions missing expected surrounding text |
| --- | --- | --- |
| Open TUI | 0 / 44 | 0 / 44 |
| Sidebar | 18 / 44 | 0 / 44 |
| Open TUI + sidebar | 18 / 44 | 0 / 44 |
| Open TUI + pi-better-render | 0 / 44 | 0 / 44 |
| Open TUI + sidebar + pi-better-render | 20 / 44 | 0 / 44 |

The last run used a 21-row image; the sidebar-only and Open TUI + sidebar runs used 19 rows. Terminal cell-size responses account for the different image heights. Open TUI and pi-better-render are not required to reproduce the defect.

A recorded physical-wheel frame had terminal width 175, conversation width 139, viewport height 50, image anchor 43, image height 21, and scroll position 52. Nine image rows were hidden and twelve should still have appeared. The frame contained no image command and no missing expected text. The user also observed the disappearance at the `AFTER IMAGE 15` position.

A later in-memory layout check used the installed Pi classes and the repository's `docs/design/preview/pi-fullscreen-mocha.png`: an `Image` and trailing text inside a primary `ScrollView`, beside sidebar text in an `HStack`, at 175 by 24 cells. An 18-row image disappeared after scrolling three rows; the unscrolled anchor row also lacked sidebar text that was present in the sidebar component's output. This checks real layout output, not terminal pixels or a completed fix.

The fixed-input checks did not reproduce missing conversation text. Do not generalize the image diagnosis to every reported text-truncation symptom.

## Evaluated approaches

| Approach | Decision or limitation |
| --- | --- |
| Wrap `applySearchHighlights()` and `prepareKittyScreen()` to repair frames and output ordering | Rejected by the user's prohibition on rewriting Pi methods; never implemented or validated as a fix |
| Change only the sidebar's `render()` or override its own `HStack.render()` | No verified repair path: fullscreen layout paints layout boxes directly, and the crop omission occurs inside Pi after component rendering |
| Restore the original full-width root while images are present | Avoids the known narrow-layout condition, but removes simultaneous sidebar display; automatic detection and switching are unimplemented and unapproved |
| Fix Pi upstream or use a future supported composition hook | Could address the underlying limitation; no upstream change, release, or suitable new hook was verified here |

Do not substitute a custom transcript renderer or interaction layer without a new design decision: that would affect the native scrolling, selection, mouse routing, and input behavior protected by the project rules. No Pi installation, settings, Open TUI code, or plugin runtime code was changed for this analysis.

## Resuming the investigation

External diagnostic artifacts are named `picture-full-probe.mjs` and `picture-diagnostic-<mode>/report.json` in the task's temporary directory. Modes are `open`, `sidebar`, `both`, `open-better`, `both-better`, and `both-wheel`. Local locations are recorded in the conversation rather than in this repository document.

Before reusing the probe, resolve its input paths: the original Open TUI worktree and PNG fixture were absent at the later check. Its sidebar import also targets the installed package; explicitly point it at the workspace when evaluating a plugin change. Keep live tests isolated from the real Pi configuration, using temporary `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, and `PI_SIDEBAR_CONFIG` as required by AGENTS.md.

No further implementation is authorized by this document. Resume after either a permitted way to retain both images and the sidebar is demonstrated, or the user accepts the visible behavior change of hiding the sidebar.

Any future fix must verify 28- and 36-column sidebars, full-width mode, top and bottom image clipping, scrolling in both directions, resize, multiple images, sidebar text beside images, surrounding conversation text, the editor, overlays, and sidebar on/off/cleanup. Repeat the complete Pi + sidebar and Pi + Open TUI + sidebar cases with physical-wheel input, including the observed `AFTER IMAGE 15` position. Presence of an escape sequence alone is insufficient visual acceptance. Run `npm run check` and regenerate screenshots when rendering changes.
