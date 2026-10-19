---
name: configure
description: Change Claude Context Manager Skill settings (handoff threshold, compaction threshold, safety limit, automatic compaction, context meter, options picker, pre-flight check, on/off) for this project or for all projects. Use when the user asks to set, change, enable or disable the context manager or its thresholds.
---

# Configure Claude Context Manager Skill

## Where settings live (highest priority first)

| Layer | File | Applies to |
|---|---|---|
| Project | `<project root>/.claude/context-manager.json` | This project only. Commit it to share with the repo |
| Universal | `<home>/.claude/context-manager.json` (Windows: `%USERPROFILE%\.claude\context-manager.json`; or `$CLAUDE_CONFIG_DIR/context-manager.json` when that is set) | Every project |
| Plugin options | `/plugin` → Installed → Claude Context Manager Skill → Configure options | Every project |
| Defaults | Built in | Fallback |

A key set in a higher layer wins; keys it leaves out fall through to the next layer. A session can also carry its own thresholds, set by the picker's "raise this session's limit" option; they end with the session.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns it off for that scope |
| `prep_at` | `130000` | Context size at which Claude writes the handoff |
| `compact_at` | `150000` | Compaction runs at this size once the handoff is saved; it is held below it |
| `force_at` | `300000` | Above this, compaction always runs, handoff or not |
| `auto_compact` | `true` | Compact automatically after the turn that reaches `compact_at`. `false`: the user types `/compact` |
| `show_meter` | `true` | Show the context meter above the prompt (terminal and desktop app) |
| `gate_manual` | `true` | A manual `/compact` with no handoff is blocked once; running it again within 2 minutes forces it |
| `offer_on_startup` | `true` | New sessions are pointed at the latest handoff saved in this project |
| `offer_options` | `true` | After a handoff, and when planned work may not fit, show the options picker |
| `preflight_check` | `true` | When Claude plans a set of tasks, it checks they fit before compaction and offers options if not |
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

1. **Show settings**: tell the user to run `/context-manager`, which prints every effective value and the layer it comes from.
2. **Change settings**: ask which scope if the user didn't say ("this project" or "all projects"). Read the target file if it exists, change only the keys asked for, keep the rest, and write valid JSON. Check that `prep_at` < `compact_at` < `force_at` and point out a conflict instead of writing it.
3. Changes apply from the user's next message; no restart is needed. Suggest `/context-manager` to confirm.
