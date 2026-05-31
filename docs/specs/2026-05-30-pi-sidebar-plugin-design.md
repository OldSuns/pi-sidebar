# Design: Pi Sidebar Plugin

**Goal:** Provide an installable pi package that adds a floating right sidebar, with a built-in Git diff/status display and a documented migration path toward first-class sidebar placement for footer/status components.

**Background:** Pi currently exposes footer/status/widget extension APIs (`ctx.ui.setStatus`, `ctx.ui.setWidget`, `ctx.ui.setFooter`, `ctx.ui.custom` overlays). A vertical information rail can hold information currently crowded into the footer: session/context, subagent/work status, LSP state, cwd/app info, and especially a repository git diff summary. Pi does not yet expose a native `setSidebar` layout API, so this package must be a plugin-level implementation that uses the supported overlay and footer APIs without patching pi core.

**Approach:** Ship a pi package named `pi-sidebar` containing one extension. On session start it creates a non-capturing right-anchored overlay that behaves like a sidebar on sufficiently wide terminals. The default layout is a floating overlay window anchored at `right-center` with a small upward offset so it lands near the visual middle of pi's transcript area rather than the mathematical middle of the full terminal. An optional full-height fixed-window style starts at the top row, covers the footer row, fills blank rows down the terminal, and includes a small left gutter before the border so present content has visual breathing room from the sidebar. The sidebar renders live sections from extension-accessible data: session title, model name, provider, thinking/reasoning level, context usage, cwd, git branch, git diff counts, changed files, and color-coded per-file add/delete deltas. It registers slash commands and shortcuts to toggle visibility, switch between full-height and floating modes, toggle git detail, and refresh.

**Rejected alternatives:**

- Patch pi core directly: rejected because the requested deliverable is a plugin and this workspace is not the pi source checkout.
- Replace the whole footer only: rejected because it cannot create the visual right rail shown in the reference image.
- Use a capturing modal overlay: rejected because a sidebar should not steal keyboard focus from normal chat/editor interaction.
- Require external dependencies such as `simple-git`: rejected to keep the plugin installable as a simple local/npm pi package and avoid production dependency friction.

**Scope:**

In scope:

- Installable pi package manifest.
- Persistent right sidebar using `ctx.ui.custom(..., { overlay: true, nonCapturing: true })`.
- Visually centered floating-window mode by default.
- Optional full-height fixed-window mode with a configurable left gutter/buffer.
- Responsive visibility threshold, configurable width, and optional auto-hide while the LLM is working.
- Git status/diff summary from the current repo using `git` CLI.
- Truncated changed-file list, compact `+/-` totals, and color-coded per-file add/delete deltas.
- Session/model/provider/thinking/context/cwd metadata sections.
- Slash commands and keyboard shortcut for user control.
- README with install/use notes and core API proposal.

Out of scope:

- True layout reflow of the main transcript around the sidebar. The plugin covers the right edge with a full-height fixed overlay and gutter, but pi core must reserve columns to genuinely push/reflow transcript and editor content left.
- Automatic relocation of arbitrary third-party footer components. Current pi APIs only expose footer statuses to a custom footer renderer, not enough to rehost every footer renderer in a sidebar.
- Interactive expand/collapse inside the sidebar. The first plugin version is informational and non-capturing.
- Full diff hunks. The plugin renders stats/file list; hunk previews are a future option.

**Key decisions:**

- **Plugin API shape:** expose `/sidebar`, `/sidebar-refresh`, and `/sidebar-git-detail`; bind `ctrl+shift+s` to toggle visibility.
- **Rendering strategy:** use a small custom `Component` class that computes lines in `render(width)` and truncates ANSI-aware via `truncateToWidth`.
- **Refresh strategy:** poll git status at a conservative interval and force refresh on turn/session/model events. Git work uses `pi.exec`, not `child_process`, so it respects pi's shell execution abstraction.
- **Responsive behavior:** default sidebar content width is 34 columns plus a 1-column gutter in full-height mode, visible only when terminal width is at least 110 columns. Users can override with environment variables.
- **Full-height behavior:** `PI_SIDEBAR_FULL_HEIGHT=0` is the default. When enabled, pi components receive width but not terminal height, so the plugin emits filler rows (`PI_SIDEBAR_FILL_ROWS`, default 200) and relies on overlay `maxHeight: "100%"` clipping to create a full-height window on normal terminals.
- **Configuration:** environment variables avoid inventing a settings file format: `PI_SIDEBAR_ENABLED`, `PI_SIDEBAR_WIDTH`, `PI_SIDEBAR_FULL_HEIGHT`, `PI_SIDEBAR_BUFFER`, `PI_SIDEBAR_FILL_ROWS`, `PI_SIDEBAR_VERTICAL_PADDING`, `PI_SIDEBAR_MIN_TERM_WIDTH`, `PI_SIDEBAR_OFFSET_Y`, `PI_SIDEBAR_AUTOHIDE_WORKING`, `PI_SIDEBAR_REFRESH_MS`, `PI_SIDEBAR_GIT_LINES`, `PI_SIDEBAR_MAX_FILES`, `PI_SIDEBAR_GIT_DETAIL`.
- **Footer behavior:** the extension does not replace pi's footer. Footer/status relocation remains a future core pi capability because complete footer-component relocation needs native sidebar layout support.

**Core pi API proposal:**

A future core implementation should add a first-class sidebar region rather than relying on overlays:

```ts
type UIRegion = "footer" | "sidebar" | "both";

ctx.ui.setSidebar(key, componentOrFactory, {
  order?: number,
  minWidth?: number,
  maxWidth?: number,
  visible?: (termWidth: number, termHeight: number) => boolean,
});

ctx.ui.setStatus(key, text, { placement?: UIRegion });
ctx.ui.setWidget(key, componentOrFactory, { placement?: "aboveEditor" | "belowEditor" | "sidebar" });
ctx.ui.setFooter(factory, { placement?: "footer" | "sidebar" | "both" });
```

Core layout should reserve columns for the sidebar, reflow the transcript/editor into the remaining width, and provide a `SidebarDataProvider` with session title, cwd, git branch, extension statuses, context usage, model, and LSP state.

**Open questions:**

- Should a native sidebar be user-configured globally by component key, e.g. “move status:model to sidebar,” or controlled by each extension?
- Should git diff hunk preview be built-in or delegated to a separate git-aware extension?
- Should sidebar interaction use focus cycling, mouse support, or slash-command-only controls?
