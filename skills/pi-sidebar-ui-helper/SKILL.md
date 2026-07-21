---
name: pi-sidebar-ui-helper
description: Use when the user wants to display extension/session state in the sidebar, configure sidebar-ui.json, or customize sidebar panels for a pi package.
---

# Configuring Sidebar Panels (`sidebar-ui.json`)

Help the user set up `sidebar-ui.json` to display extension data in pi-sidebar panels.

## Workflow

### 1. Global or Local?

Ask concretely:

> Do you want this for all pi projects or just the current one?
> **All projects (global):** `~/.pi/agent/sidebar-ui.json`
> **Current project (local):** `./.pi/sidebar-ui.json`

### 2. Find Available Data

**If user names a package:** grep its extensions for `appendEntry()`:

```bash
grep -rn "appendEntry" node_modules/<package>/extensions/ node_modules/<package>/src/
```

**If user can't name a package:** ask what data they want to see, then search installed packages:

```bash
grep -rn "appendEntry" ~/.pi/agent/npm/node_modules/*/src/ ~/.pi/agent/npm/node_modules/*/extensions/ 2>/dev/null
```

The first argument to `appendEntry()` is the `customType` (= `entryType` in config). The second argument is the data object — its keys become field paths.

### 3. Build the Config

```jsonc
{
  "panels": {
    "<panel-key>": {
      "label": "<Heading>",
      "entryType": "<customType>",
      "variables": {
        "<field.path>": "<Display Label>"
      },
      "compact": false
    }
  }
}
```

- Use dot notation for nested fields: `goal.text`, `0.usedPercent`
- `compact: true` puts all variables on one line (short values only)
- Long values are word-wrapped automatically

### 4. Apply

Write the file, tell user to run `/reload`.

## Known Entry Types

| `entryType` | Source | Typical Data |
|---|---|---|
| `goal-state` | Built-in pi | `{ goal: { text, status, tokensUsed } }` |
| `quotas:usage` | `@latentminds/pi-quotas` | `[{ label, usedPercent, ... }]` |

## Value Formatting

- Numbers ≥1M → `1.5M`, ≥1K → `965k`
- Booleans → `yes` / `no`
- null → `—`
- Long strings → auto word-wrapped with continuation indent
