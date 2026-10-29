# AGENTS

## The project

`@oldsuns/pi-sidebar` is an extension for Pi's (`@earendil-works/pi-coding-agent`) fullscreen TUI. It puts a permanent sidebar to the right of the conversation with the session, context, usage, activity, git and tools. Fullscreen only; nothing is shown in regular mode.

Layout: `src/host/` layout integration, `src/state/` data and snapshots, `src/ui/` rendering, `src/git/` read-only git, `scripts/` checks and preview tools, `docs/design/` the design document and screenshots.

## Hard rules

- **The main window keeps its behaviour.** The only allowed effect is that the usable width drops by 28 or 36 columns while the sidebar is visible. Do not replace or decorate the editor, footer or header; open no overlays or dialogs; register no shortcuts or input listeners; never take keyboard focus; never write to the session; event handlers return nothing. The rules are in `docs/design/pi-sidebar-design.md` §4.0, and `npm run rules` enforces them in CI.
- The plugin has exactly one private access: reading `tui.layoutRoot` in `src/host/layout-host.ts`. Do not read it anywhere else.
- Import only `@earendil-works/*`; add no dependencies at all, dev dependencies included. Type checks and tests use the installed Pi.
- Source uses erasable TypeScript syntax only (`erasableSyntaxOnly`); relative imports carry the `.ts` extension so Node runs them without a build.
- `render` is a pure function of the snapshot: no Pi API calls, no I/O, elapsed time taken from the snapshot's `clock`.

## Commands

```bash
npm run check        # rules + typecheck + test + pack:check + docs; run this after a change
npm test
npm run typecheck
npm run rules
npm run docs
npm run preview -- ansi   # the real renderer with sample data, in colour
npm run screenshots       # the images in docs/design/preview, from a real Pi (needs Chrome or Edge, and git; not run in CI); one Pi per CONTEXT state for the §6.6 gallery
npm run bench             # timings of rendering and scans
```

- Tests and type checks resolve `@earendil-works/*` from `~/.pi/agent/install/releases/<version>/node_modules`; set `PI_NODE_MODULES` to use another Pi.
- After changing anything that renders, run `npm run screenshots` so the images match the code.
- The screenshots come from `scripts/screenshot.ts`; do not edit the images by hand. It uses an isolated temporary home, agent directory and repository, never reads or writes the real `~/.pi`, and makes no network calls.

## Code conventions

- Comments, identifiers and commit messages are English; the design document and conversation are Chinese.
- Comments cite the design rules (`MAIN-x`, `R-x`, `D-x`, `PERF-x`, `SEC-x`, `PKG-x`, `TEST-x`). When a rule changes, update its number in the document so the citations stay valid.
- New data goes in `src/state/`; a new panel is a pure function in `src/ui/panels.ts` and must handle both widths, 28 and 36.
- Branch names, file names, session names, tool arguments and other external text go through `src/util.ts` to strip terminal sequences and control characters before they are displayed.
- Measure with `visibleWidth` and cut with `truncatePlain`; never insert escape codes that break a coloured run.

## Safety

- Never read credentials such as `~/.pi/agent/auth.json`; billing uses the boolean `isUsingOAuth` only.
- Never modify the user's Pi settings. Live tests use a temporary `PI_SIDEBAR_CONFIG` and an isolated `HOME`, `USERPROFILE` and `PI_CODING_AGENT_DIR`.
- Git runs only the read-only commands and fixed flags listed under `SEC-1`, offline and without prompts.

## Documentation

- When rendering, commands, settings or behaviour change, update both `README.md` and the design document; `npm run docs` checks links, tables and code fences.
- Keep the documentation short: state the conclusion and its evidence, not the history. This is an independent project; do not describe it in terms of other projects.

## Commits

- Do not commit, push or publish unless asked. The licence is MIT (`LICENSE`); `package.json` must agree with it.
- The tree is CRLF (`core.autocrlf=true`). Write content with backslashes (escapes, regexes) through the editor tools, not a Bash heredoc — heredocs here swallow `\n`, `\d` and the like.
