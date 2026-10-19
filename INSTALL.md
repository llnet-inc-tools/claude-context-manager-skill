# Installing Claude Context Manager Skill

A Claude Code plugin that saves a handoff before your context is compacted, checks planned work against the context budget, offers the right next step and runs the one you pick, compacts at your threshold, gives the handoff back to Claude afterwards, and shows a live context meter.

## Requirements

| | |
|---|---|
| Claude Code | A recent version (tested with 2.1.303): the terminal app, the Claude desktop app's **Code** tab, or an IDE extension. Update with `claude update`, or update the desktop app |
| Operating system | Windows, macOS, Linux or WSL. Nothing else to install |
| Plan | Any plan that includes Claude Code |

Not supported: cloud sessions (claude.ai/code), claude.ai chat and Cowork. See [Compatibility](README.md#compatibility).

> **Working over SSH?** Install the plugin on the remote machine as well, from inside the SSH session. Plugins installed on your own computer bring their skills to an SSH session but not their hooks, and the hooks do all the work.

## 1. Install

### Option A: one command, in any Claude Code session

```
/plugin install context-manager-skill --marketplace llnet-inc-tools/claude-context-manager-skill
```

Confirm adding the marketplace when asked, then [choose a scope](#2-choose-a-scope).

### Option B: Claude desktop app, step by step

1. In the **Code** tab, send:
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

### Option D: for everyone working in a repository

Run this once in the repository, then commit `.claude/settings.json`:

```
claude plugin marketplace add llnet-inc-tools/claude-context-manager-skill --scope project
claude plugin install context-manager-skill@llnet-inc-tools --scope project
```

Collaborators get the marketplace once they trust the folder, and each runs the `install` line once.

## 2. Choose a scope

| Scope | Effect |
|---|---|
| **User** | On in every project on this computer |
| **Project** | On for this repository; recorded in the repo's `.claude/settings.json`, so it travels with the repo |
| **Local** | On in this repository, for you only |

## 3. Turn on automatic updates

A marketplace can't switch auto-update on for you, so do it once. Claude Code's plugin settings are shared by the terminal and the desktop app's Code tab on the same computer, so doing it in either covers both.

> **Not in the Claude app's Settings → Plugins.** That page manages claude.ai and Cowork plugins. Claude Code marketplaces such as `llnet-inc-tools` don't appear there.

| Option | How |
|---|---|
| **One-step script** | Open PowerShell and paste: `irm https://raw.githubusercontent.com/llnet-inc-tools/claude-context-manager-skill/main/scripts/update-and-enable-autoupdate.ps1 \| iex`. It updates the plugin, turns auto-update on and keeps a backup of your settings. Or download [`scripts/update-and-enable-autoupdate.ps1`](scripts/update-and-enable-autoupdate.ps1) and right-click → **Run with PowerShell** (macOS/Linux: `pwsh ./update-and-enable-autoupdate.ps1`) |
| **Terminal menu** | Run `claude` in a terminal, send `/plugin`, press **Tab** to reach **Marketplaces**, select `llnet-inc-tools`, choose **Enable auto-update** |
| **Settings file** | In `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`), add `"autoUpdate": true` to the `llnet-inc-tools` entry under `extraKnownMarketplaces`. You can ask Claude Code to make this edit. A value set here locks the toggle in `/plugin` |

New releases then install in the background and apply from your next session.

**Update now**, without waiting (any terminal):

```
claude plugin marketplace update llnet-inc-tools
claude plugin update context-manager-skill@llnet-inc-tools
```

The first line refreshes the marketplace listing; until it runs, **Update** in the plugin manager stays greyed out because Claude Code doesn't know a newer version exists. Restart the app or start a new session afterwards.

Organization admins can turn auto-update on for everyone with `"autoUpdate": true` on the marketplace's `extraKnownMarketplaces` entry in managed settings.

## 4. Check that it works

Run `/context-manager`. You should see `Status  active in this session` along with your current context size.

To watch the whole cycle without waiting for 130k tokens, lower the thresholds for one project. Create `.claude/context-manager.json`:

```json
{ "prep_at": "20k", "compact_at": "30k" }
```

Keep working. Past 20k, the meter turns to `handoff due now`, Claude writes the handoff and confirms it, and past 30k the plugin compacts after the turn. Your next message comes with the handoff restored. Delete the file afterwards to return to the defaults.

## How it works

| Context size | What happens |
|---|---|
| Below 130k (`prep_at`) | Nothing, apart from the meter |
| 130k | Claude writes a handoff (goal, status, decisions, key files, next steps) and confirms it |
| Below 150k (`compact_at`), or no finished handoff | Compaction is held, including Claude Code's own automatic compaction |
| 150k with a finished handoff | The plugin compacts after the current turn; the handoff is given back to Claude on your next message |
| 300k (`force_at`) | Safety valve: compaction always runs |
| New session in the same project | Claude is pointed at the most recent handoff |

A manual `/compact` with no handoff is blocked once. Run it again within 2 minutes to compact anyway.

## The options picker

When there's a decision to make, the plugin shows a short list of options, with the one Claude recommends first. In the terminal and desktop app they appear as buttons above the prompt: click one, or press its number (`0` dismisses). In VS Code, Claude asks the same question with a multiple-choice prompt. Picking an option runs it; you never need to type the command.

**After a handoff is saved**, Claude judges where the work stands:

| Where the work stands | Recommended | What the option does |
|---|---|---|
| Work continues normally | **Keep going** | Compacts automatically at `compact_at` |
| Partway through a risky step | **Finish this step, then compact** | Claude finishes the step and updates the handoff; then the plugin compacts |
| Task about done, or switching topics | **Start a fresh session** | Clears the session; the next one is pointed at the handoff |
| A long task remains | **Continue in a fresh session** | Clears the session and automatically asks the new one to continue from the handoff |
| | Compact now | Compacts as soon as the current turn ends |
| | Review the handoff | Claude summarises it and asks what to change |
| | Snooze | Raises this project's thresholds by 100k |

**Before a set of tasks** (Claude creates a task list, you approve a plan, or you run `/context-manager-skill:plan-check`), Claude estimates how much context the work needs. If it won't fit before compaction, Claude stops and you choose:

| Option | What it does |
|---|---|
| **Raise this session's limit** | Raises this session's thresholds to fit the estimate (shown when it fits the model's window). Larger context costs more per turn. Ends with the session |
| **Continue in a fresh session** | Saves a handoff if needed, clears the session and starts the new one on the work, with a clean context |
| **Go ahead** | Starts anyway; compaction happens when it's needed |

Options picked while Claude is working run as soon as the current turn ends. Turn the picker off with `offer_options: false`, or just the pre-flight check with `preflight_check: false`.

## Configure

Ask Claude in plain language:

```
/context-manager-skill:configure for this project, prep at 250k and compact at 280k
/context-manager-skill:configure turn off automatic compaction for all projects
/context-manager-skill:configure turn it off for this project
```

Or edit the settings files directly. Higher layers win:

| Layer | Location |
|---|---|
| Project | `<project>/.claude/context-manager.json` |
| All projects | `~/.claude/context-manager.json` (Windows: `%USERPROFILE%\.claude\context-manager.json`) |
| Plugin options | `/plugin` → **Installed** → Claude Context Manager Skill → **Configure options** |
| Built-in defaults | `prep_at` 130k, `compact_at` 150k, `force_at` 300k |

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns it off |
| `prep_at` | `130000` | When Claude writes the handoff |
| `compact_at` | `150000` | Compaction runs at this size once the handoff is saved; held below it |
| `force_at` | `300000` | Compaction always runs above this |
| `auto_compact` | `true` | Compact automatically. `false`: you're told when to type `/compact` |
| `show_meter` | `true` | Context meter above the prompt (terminal and desktop app) |
| `gate_manual` | `true` | Block a manual `/compact` once when there's no handoff |
| `offer_on_startup` | `true` | Point new sessions at the latest handoff |
| `offer_options` | `true` | Show the options picker after a handoff and when planned work may not fit |
| `preflight_check` | `true` | Check planned work against the context budget before starting it |
| `handoff_dir` | `.claude/context-manager/handoffs` | Where handoffs are saved |

Numbers can be written as `150000`, `"150k"` or `"1.2m"`. Changes apply from your next message. `/context-manager` shows the value in effect and where it came from.

## Commands

| Command | What it does |
|---|---|
| `/context-manager` | Status: context size, handoff state, effective settings |
| `/context-manager options` | Show the options picker now |
| `/context-manager run <option>` | Run an option by name (`auto`, `compact_now`, `finish_step`, `fresh_session`, `continue_fresh`, `expand`, `review`, `snooze`) |
| `/context-manager-skill:plan-check` | Check whether upcoming work fits before compaction |
| `/context-manager-skill:prep-compact` | Write a handoff now |
| `/context-manager-skill:configure` | Show or change settings |

## Upgrading from 1.x

Version 2 runs inside Claude Code instead of through PowerShell, and compacts on its own.

- If you set the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` environment variable for 1.x, you can remove it. It's harmless, but no longer needed. In PowerShell:
  ```powershell
  [Environment]::SetEnvironmentVariable('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', $null, 'User')
  ```
  On macOS or Linux, delete its `export` line from your shell profile.
- `/context-manager-skill:status` is now `/context-manager`.
- Settings files and saved handoffs carry over unchanged.

## Uninstall

`/plugin` → **Installed** → Claude Context Manager Skill → **Uninstall** (in the desktop app: **+** → **Plugins** → **Manage plugins**). Or from a terminal:

```
claude plugin uninstall context-manager-skill@llnet-inc-tools
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Over SSH: *"these plugins come from your computer and run without their hooks"* | Install it on the remote machine from inside the SSH session (step 1), then start a new session |
| **Update** is greyed out | Run `claude plugin marketplace update llnet-inc-tools`, then update (see step 3) |
| `/context-manager` isn't listed | In an SSH session, see the row above. Otherwise check the plugin is enabled (`/plugin` → **Installed**), then update Claude Code. Older versions can't load mods |
| `/plugin` says mods are blocked, or the plugin never runs on a work machine | Your organization restricts user-installed mods (`allowManagedModsOnly`). Ask your admin to install it through managed settings |
| Nothing happens past 130k | Run `/context-manager`. It shows whether a settings file turned it off or raised `prep_at`, and lists any settings problems |
| It never compacts | Check `auto_compact` is `true` and the handoff shows as saved in `/context-manager`. Compaction waits for the turn to finish |
| "Holding compaction until ~Nk" | Expected: Claude Code tried to compact before your `compact_at`. Lower `compact_at` if you want it sooner |
| No meter | The meter shows in the terminal and the desktop app only, and only when `show_meter` is `true` |

Report other issues at https://github.com/llnet-inc-tools/claude-context-manager-skill/issues
