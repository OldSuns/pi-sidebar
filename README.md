# @oldsuns/pi-sidebar

Floating right sidebar for the [pi coding harness](https://pi.dev) showing model, context, git, and session metadata. Unofficial fork of [esso0428/pi-sidebar](https://github.com/esso0428/pi-sidebar) (which forked [jrimmer/pi-sidebar](https://github.com/jrimmer/pi-sidebar)).

## Features

- Floating right sidebar (default) or full-height fixed-window mode
- Model + reasoning level, context usage, current branch + diff summary, per-file deltas
- Auto-hide while the LLM is working
- Custom data panels via `sidebar-ui.json`

## Install

```bash
pi install npm:@oldsuns/pi-sidebar
```

From source:

```bash
git clone https://github.com/OldSuns/pi-sidebar
cd pi-sidebar
pi install ./
```

One-shot run without installing:

```bash
pi -e npm:@oldsuns/pi-sidebar
```

Reload after install inside pi:

```text
/reload
```

Manage:

```bash
pi list
pi update --extensions
pi remove npm:@oldsuns/pi-sidebar
```

## Commands

- `/sidebar` — toggle visibility
- `/sidebar on|off|status|full|floating`
- `/sidebar-refresh` — refresh git/status data
- `/sidebar-git-detail` — toggle changed-file list length
- `/sidebar-panels on|off` — toggle panels compact mode
- `ctrl+shift+s` — toggle sidebar

## Custom Panels

Configure via `~/.pi/agent/sidebar-ui.json` (global) or `.pi/sidebar-ui.json` (local):

```json
{
  "panels": {
    "goal": {
      "label": "Goal",
      "entryType": "goal-state",
      "variables": {
        "goal.text": "Goal",
        "goal.status": "Status"
      }
    }
  }
}
```

Bundled skill `pi-sidebar-ui-helper` walks the LLM through config generation:

```text
/skill:pi-sidebar-ui-helper
```

## Environment Variables

| Variable | Default | Description |
| --- | ---: | --- |
| `PI_SIDEBAR_ENABLED` | `1` | Start enabled. |
| `PI_SIDEBAR_WIDTH` | `34` | Sidebar content columns. |
| `PI_SIDEBAR_FULL_HEIGHT` | `0` | Use full-height mode. |
| `PI_SIDEBAR_MIN_TERM_WIDTH` | `110` | Auto-hide below this terminal width. |
| `PI_SIDEBAR_AUTOHIDE_WORKING` | `1` | Hide while the LLM is working. |
| `PI_SIDEBAR_REFRESH_MS` | `5000` | Git polling interval (ms). |
| `PI_SIDEBAR_GIT_LINES` | `12` | Max changed-file rows. |
| `PI_SIDEBAR_GIT_DETAIL` | `1` | Start with detailed changed-file list. |

## Git Data

Uses `pi.exec` to run static `git` commands (`rev-parse`, `branch --show-current`, `diff --shortstat`, `status --porcelain=v1`, `diff --numstat HEAD --`). No shell strings assembled from user input; only paths and diff counts are displayed.

## Development

```bash
npm install --ignore-scripts
npm run verify
```

`npm run verify` runs typecheck, tests, and `npm pack --dry-run`.

Add a section by creating a renderer in `extensions/sidebar/sections/<name>.ts` and registering it in `compositor.ts`'s `buildSidebarContent`.

## License

BSD-3-Clause.
