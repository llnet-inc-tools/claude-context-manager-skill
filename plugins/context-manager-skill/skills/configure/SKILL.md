---
name: configure
description: Show or change context-manager settings (prepare-handoff threshold, compaction threshold, safety limit, on/off) for this project or for all projects, and set the auto-compact trigger. Use when the user asks to view, set, change, enable or disable context-manager or its thresholds.
---

# Configure context-manager

## Where settings live (highest priority first)

| Layer | File | Applies to |
|---|---|---|
| Project | `<project root>/.claude/context-manager.json` | This project only. Commit it to share with the repo |
| Universal | `~/.claude/context-manager.json` (on Windows `%USERPROFILE%\.claude\context-manager.json`) | Every project |
| Plugin options | Set from the plugin's **Configure options** (`/plugin` → Installed → context-manager) | Every project |
| Defaults | Built in | Fallback |

A key set in a higher layer wins; keys it leaves out fall through to the next layer.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn context-manager off for a project with `false` |
| `prep_at` | `130000` | Context size at which Claude writes the handoff |
| `compact_at` | `150000` | Auto-compaction is held below this size |
| `force_at` | `300000` | Above this, compaction always runs, handoff or not |
| `gate_manual` | `true` | When `true`, a manual `/compact` without a handoff is blocked once (running it again within 2 minutes forces it) |
| `offer_on_startup` | `true` | New sessions are told about the latest handoff saved in this project |
| `handoff_dir` | `.claude/context-manager/handoffs` | Where handoffs are saved, relative to the project root |

Numbers may be written as `150000`, `"150k"` or `"1.2m"`.

Example project file:

```json
{
  "prep_at": "250k",
  "compact_at": "280k"
}
```

## How to handle a request

1. **Show settings**: tell the user to run `/context-manager-skill:status`, which prints the effective value of every key and the layer it comes from. If they want it from you, read both JSON files and report the same in a short table.
2. **Change settings**: ask which scope if the user didn't say ("this project" or "all projects"). Read the target file, change only the keys asked for, keep the rest, and write valid JSON. Check that `prep_at` < `compact_at` < `force_at` and point out a conflict instead of writing it.
3. **Auto-compact trigger**: Claude Code only attempts auto-compaction when context crosses the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` percentage, a Windows user environment variable that applies to all projects. It should match the lowest `compact_at` the user uses. To set it, with the user's go-ahead, run:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/set-autocompact.ps1" -Tokens <lowest compact_at>
   ```

   Add `-Clear` instead of `-Tokens` to remove it. Tell the user the app must be fully quit and reopened for it to take effect. Without it, context-manager still prepares the handoff and tells the user when to type `/compact`.
4. Settings files are read on every prompt, so changes to them apply immediately; no restart needed.
