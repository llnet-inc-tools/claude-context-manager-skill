# Installing Claude Context Manager Skill

A Claude Code plugin that saves a handoff before your context is compacted, holds auto-compaction until that handoff exists, and feeds it back to Claude afterwards.

## Requirements

| | |
|---|---|
| Operating system | **Windows** (the hooks run with the built-in Windows PowerShell). macOS and Linux aren't supported yet |
| Claude Code | A recent version: the Claude desktop app's **Code** tab, the `claude` terminal app, or the VS Code extension |
| Plan | Any plan that includes Claude Code |

## 1. Install

Pick whichever fits how you use Claude Code.

### Option A: one command, inside a Claude Code session

Paste this into the prompt box (Claude Code 2.1.275 or later):

```
/plugin install context-manager-skill --marketplace llnet-inc-tools/claude-context-manager-skill
```

Confirm adding the marketplace when asked, then choose a scope (see [Choose a scope](#2-choose-a-scope)).

### Option B: Claude desktop app, step by step

1. Open the **Code** tab and send:
   ```
   /plugin marketplace add llnet-inc-tools/claude-context-manager-skill
   ```
2. Click **+** next to the prompt box → **Plugins** → **Add plugin**.
3. Select **Claude Context Manager Skill** and choose a scope.

### Option C: from a terminal

```
claude plugin marketplace add llnet-inc-tools/claude-context-manager-skill
claude plugin install context-manager-skill@llnet-inc-tools --scope user
```

Use `--scope project` instead to turn it on for one repository.

## 2. Choose a scope

| Scope | Effect |
|---|---|
| **User** | On in every project on this computer |
| **Project** | On for this repository. Recorded in the repo's `.claude/settings.json`, so it travels with the repo. Each collaborator still installs the plugin once |
| **Local** | On in this repository for you only |

## 3. Set the auto-compact trigger (recommended)

Claude Code decides *when* to attempt auto-compaction from one Windows setting, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. The plugin decides *whether* that compaction is allowed to run. Set the trigger to the lowest compaction threshold you plan to use (default 150k).

Ask Claude in any session:

```
/context-manager-skill:configure set the auto-compact trigger to 150k
```

Or run this yourself in PowerShell (15 = 15% of a 1M-token window, about 150k):

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '15', 'User')
```

Then **fully quit Claude** (including from the system tray) and reopen it.

Without this step the plugin still prepares the handoff and tells you when to type `/compact`. It just won't compact for you.

> On a model with a 200k context window, the same percentage means about 30k tokens.

## 4. Check that it works

To see it fire without waiting for 130k tokens, lower the threshold temporarily for one project. Create `.claude/context-manager.json` in that project:

```json
{ "prep_at": "20k", "compact_at": "30k" }
```

Send a few messages. Once context passes 20k you should see:

> Context at ~20k. Claude will save a handoff before compacting.

Claude then writes the handoff to `.claude/context-manager/handoffs/` and confirms it in one line. Delete the test file afterwards to go back to the defaults.

## How it works

| Context size | What happens |
|---|---|
| 130k (`prep_at`) | Claude writes a handoff (goal, status, decisions, key files, next steps) and confirms it |
| Below 150k (`compact_at`), or no finished handoff | Auto-compaction is held |
| At 150k with a finished handoff | Compaction runs; the handoff is given back to Claude right after |
| 300k (`force_at`) | Safety valve: compaction always runs |
| New session in the same project | Claude is pointed at the most recent handoff |

A manual `/compact` with no handoff is blocked once. Run it again within 2 minutes to compact anyway.

Handoffs are saved in `<project>/.claude/context-manager/handoffs/`. That folder ignores itself in git automatically.

## Configure

Ask Claude in plain language:

```
/context-manager-skill:status
/context-manager-skill:configure for this project, prep at 250k and compact at 280k
/context-manager-skill:configure turn it off for this project
```

Or edit the settings files directly. Higher layers win:

| Layer | Location |
|---|---|
| Project | `<project>/.claude/context-manager.json` |
| All projects | `%USERPROFILE%\.claude\context-manager.json` |
| Plugin options | `/plugin` → **Installed** → Claude Context Manager Skill → **Configure options** |
| Built-in defaults | `prep_at` 130k, `compact_at` 150k, `force_at` 300k |

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns it off |
| `prep_at` | `130000` | When Claude writes the handoff |
| `compact_at` | `150000` | Auto-compaction is held below this |
| `force_at` | `300000` | Compaction always runs above this |
| `gate_manual` | `true` | Block a manual `/compact` once when there's no handoff |
| `offer_on_startup` | `true` | Point new sessions at the latest handoff |
| `handoff_dir` | `.claude/context-manager/handoffs` | Where handoffs are saved |

Numbers can be written as `150000`, `"150k"` or `"1.2m"`. Changes apply on the next message; no restart needed.

## Commands

| Command | What it does |
|---|---|
| `/context-manager-skill:status` | Confirm it's active in this session and show context size, handoff state and effective settings |
| `/context-manager-skill:prep-compact` | Write a handoff now |
| `/context-manager-skill:configure` | Show or change settings |

## Update

`/plugin` → **Installed** → Claude Context Manager Skill → **Update now**, or from a terminal:

```
claude plugin update context-manager-skill@llnet-inc-tools
```

Or turn on automatic updates: `/plugin` → **Marketplaces** → `llnet-inc-tools` → **Enable auto-update**.

## Uninstall

`/plugin` → **Installed** → Claude Context Manager Skill → **Uninstall** (in the desktop app: **+** → **Plugins** → **Manage plugins**). Or from a terminal:

```
claude plugin uninstall context-manager-skill@llnet-inc-tools
```

Then remove the auto-compact trigger if you set it:

```powershell
[Environment]::SetEnvironmentVariable('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', $null, 'User')
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "hook error" notices on every message | Run `/hooks` to see which hook failed. Most often PowerShell is blocked by a company policy; check with `Get-ExecutionPolicy -List` |
| Nothing happens past 130k | Check that the plugin is enabled (`/plugin` → **Installed**) and that no `context-manager.json` sets `enabled` to `false` or raises `prep_at` |
| Auto-compaction never runs | Set the auto-compact trigger (step 3) and fully restart Claude. Until then, type `/compact` when prompted |
| "Holding auto-compaction until ~Nk" every turn | The trigger is lower than this project's `compact_at`. Raise the trigger or lower `compact_at` |

Report other issues at https://github.com/llnet-inc-tools/claude-context-manager-skill/issues
