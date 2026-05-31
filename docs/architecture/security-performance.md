# Sidebar Architecture, Security, and Performance Review

## Current architecture

`pi-sidebar` is a pi package with a single extension at `extensions/sidebar.ts`.

The extension:

- registers a non-capturing right-anchored overlay via `ctx.ui.custom(...)`;
- defaults to a floating overlay window and can optionally use a full-height visual window with `maxHeight: "100%"`, a one-column gutter, and filler rows;
- polls local git state with `pi.exec("git", [...])`;
- renders session/model/provider/thinking/context/git/cwd information in a sidebar component;
- renders changed-file rows with per-file `git diff --numstat` deltas when available;
- registers `/sidebar`, `/sidebar-refresh`, `/sidebar-git-detail`, and `ctrl+shift+s`.

## Security review

### Command execution

The extension only invokes the `git` executable with static argument arrays:

- `git rev-parse --is-inside-work-tree`
- `git branch --show-current`
- `git diff --shortstat`
- `git status --porcelain=v1`
- `git diff --numstat HEAD --`
- `git rev-parse --short HEAD`

User-controlled data is not concatenated into shell strings. The `cwd` is supplied through the pi extension context and each command uses a short timeout.

### Data exposure

The sidebar displays local repository metadata that pi already has access to:

- current working directory;
- branch name;
- changed file paths;
- diff insertion/deletion counts;
- model and approximate context usage.

It does not read file contents, secrets, environment variable values, or untracked file contents. File paths may still reveal sensitive project structure, so users should treat screenshots as potentially sensitive.

### Input handling

The overlay is `nonCapturing`, so it does not intercept editor or terminal input. Slash commands only toggle in-memory state or trigger a git refresh.

### Dependency surface

Runtime dependencies are pi peer packages only, matching pi package guidance for `@earendil-works/*` imports. Test tooling is dev-only and version-ranged rather than `latest` for reproducible installs. The package manifest uses `files` to keep packed artifacts focused on extension/docs rather than local cache directories or tests. The package is licensed as BSD-3-Clause.

## Performance review

### Git polling

Default polling interval is 5 seconds (`PI_SIDEBAR_REFRESH_MS=5000`). Each refresh runs inexpensive git commands with 1500ms timeouts and a `refreshing` guard to prevent overlapping refreshes. Per-file deltas come from `git diff --numstat HEAD --`.

Potential costs:

- very large repositories can make `git status --porcelain=v1` slower;
- slow filesystem/network-mounted repos may hit timeouts;
- frequent terminal renders can occur during active turns.

Mitigations already present:

- timeout on every git command;
- no overlapping refreshes;
- bounded changed-file rendering (`PI_SIDEBAR_MAX_FILES`, default 12);
- visibility threshold for narrow terminals;
- component render output is simple strings, not expensive nested UI state.

### Full-height rendering

Current pi overlay components receive render width but not terminal height. Full-height mode emits filler rows (`PI_SIDEBAR_FILL_ROWS`, default 200) and relies on overlay clipping. This is cheap for normal terminal sizes, but it is still a workaround. If terminals become extremely tall, users can increase `PI_SIDEBAR_FILL_ROWS`; if render volume matters, they can reduce it or use `/sidebar floating`.

### Future mouse interaction

Sidebar visibility is keyboard-first (`ctrl+shift+s`, `/sidebar collapse`, `/sidebar expand`). Mouse click support is intentionally not implemented in this plugin version: terminal mouse reporting is global, interferes with normal wheel scrolling, and proved unreliable for non-capturing overlays. A future pi core implementation should provide scoped non-capturing overlay click regions, or a way to forward wheel events, before the sidebar reintroduces click hide/restore.

### Recommended future tuning

- Add first-class/scoped mouse click support in pi core before reintroducing sidebar click affordances.
- Add optional event-driven git refresh when pi exposes filesystem/git events.
- Cache git output and skip render requests when state is unchanged.
- Add a max git status timeout/env override if users report large-repo latency.

## Current risk rating

- Security: low risk.
- Performance: low to moderate risk, mostly in very large repositories.
- UX/layout: moderate limitation because overlay mode cannot truly reserve terminal columns.
