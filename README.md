# Claude Context Manager Skill

[![CI](https://github.com/llnet-inc-tools/claude-context-manager-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/llnet-inc-tools/claude-context-manager-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Claude Code plugin that keeps long sessions from being compacted out from under you, and keeps them small enough to stay cheap.

1. **Check before big work.** When Claude plans a set of tasks, it estimates whether they fit before compaction. If not, you choose: raise this session's limit, continue in a fresh session that picks up automatically, or go ahead anyway.
2. **Prepare.** At 130k tokens, Claude writes a handoff (goal, status, decisions, key files, next steps).
3. **Offer the right next step.** Claude judges where the work stands and you get a short list of options, recommended one first: keep going, compact now, finish this step then compact, start fresh, continue in a fresh session, review the handoff, or snooze. Picking one runs it.
4. **Gate and compact.** Compaction is held below 150k and until the handoff is complete, then runs on its own after the turn. Above 300k it always runs, as a safety valve.
5. **Restore and carry over.** After compaction the handoff is given back to Claude, and a new session in the same project is pointed at it.
6. **See it.** A live meter above the prompt shows context size and handoff state, and holds the option buttons when there's a choice to make:
   ```
   Context 142k / 1M (14%) · handoff saved · compact at 150k
   Mid-migration; finish the schema change first. How do you want to continue?
   [ Finish this step, then compact (recommended) ]  Keep going  Compact now  Start a fresh session  …
   ```

Every threshold can be set per project or for all projects. Handoffs are saved in `<project>/.claude/context-manager/handoffs/`, and that folder git-ignores itself.

## Install

Paste this into any Claude Code session:

```
/plugin install context-manager-skill --marketplace llnet-inc-tools/claude-context-manager-skill
```

Pick **user** scope for every project, or **project** scope for one repository. Then turn on automatic updates: run `claude` in a terminal, `/plugin` → **Marketplaces** → `llnet-inc-tools` → **Enable auto-update** (it's not in the Claude app's Settings → Plugins page; [INSTALL.md](INSTALL.md#3-turn-on-automatic-updates) has another way).

**[INSTALL.md](INSTALL.md)** has the desktop-app and terminal steps, how to check it works, and troubleshooting.

## Compatibility

| | Supported | Notes |
|---|---|---|
| **Windows, macOS, Linux, WSL** | ✅ | No scripts, shells or runtimes needed; the plugin runs inside Claude Code |
| **Claude Code in a terminal** | ✅ | Including JetBrains IDEs, which run it in their terminal. Meter shown |
| **Claude desktop app, Code tab** | ✅ | Meter shown |
| **VS Code extension** | ✅ | No meter or buttons; Claude asks the same options with a multiple-choice prompt |
| **SSH sessions** (desktop app, VS Code Remote) | ✅ | Install the plugin **on the remote machine** too. Over SSH, plugins from your own computer bring their skills but not their hooks |
| **Cloud sessions** (claude.ai/code) | ❌ | Cloud sessions don't load plugins installed on your machine |
| **claude.ai chat, Cowork** | ❌ | This plugin uses Claude Code hooks, which those apps don't run |
| **Organization-managed Claude Code** | ⚠️ | Admins can block user-installed mods (`allowManagedModsOnly`). The compaction gate only runs when your organization installs the plugin through managed settings |

Requires a recent Claude Code (tested with 2.1.303). Update with `claude update`, or update the desktop app.

## Commands

| Command | What it does |
|---|---|
| `/context-manager` | Status: context size, handoff state, and every setting with where it comes from |
| `/context-manager options` | Show the options picker now |
| `/context-manager run <option>` | Run an option by name: `auto`, `compact_now`, `finish_step`, `fresh_session`, `continue_fresh`, `expand`, `review`, `snooze` |
| `/context-manager-skill:plan-check` | Check whether the work you're about to start fits before compaction |
| `/context-manager-skill:prep-compact` | Write a handoff now |
| `/context-manager-skill:configure` | Change settings in plain language, e.g. *"for this project, prep at 250k and compact at 280k"* |

## Settings

Highest priority first:

| Layer | File |
|---|---|
| Project | `<project>/.claude/context-manager.json` |
| All projects | `~/.claude/context-manager.json` (Windows: `%USERPROFILE%\.claude\context-manager.json`) |
| Plugin options | `/plugin` → **Installed** → Claude Context Manager Skill → **Configure options** |
| Defaults | prep 130k · compact 150k · safety 300k |

Keys: `enabled`, `prep_at`, `compact_at`, `force_at`, `auto_compact`, `show_meter`, `offer_options`, `preflight_check`, `gate_manual`, `offer_on_startup`, `handoff_dir`. Numbers can be `150000` or `"150k"`. [INSTALL.md](INSTALL.md#configure) describes each one.

## Updates and versioning

Releases follow [Semantic Versioning](https://semver.org/) and are listed in [CHANGELOG.md](CHANGELOG.md) and on the [releases page](https://github.com/llnet-inc-tools/claude-context-manager-skill/releases).

- **Automatic updates:** turn on auto-update for the `llnet-inc-tools` marketplace once (see Install). Claude Code then installs new releases in the background, and they apply from your next session.
- **Manual update:** `claude plugin marketplace update llnet-inc-tools`, then `claude plugin update context-manager-skill@llnet-inc-tools`.

### Releasing (maintainers)

1. Make the change. The `version` in `plugins/context-manager-skill/.claude-plugin/plugin.json` must go up, because installed copies only update when it changes.
2. Add a `## [x.y.z]` section to `CHANGELOG.md`.
3. Open a pull request. CI validates the marketplace and plugin, runs the tests, and fails if the plugin changed without a version bump and changelog entry.
4. Merge to `main`. The release workflow tags `context-manager-skill--vx.y.z` and publishes the GitHub release, with notes taken from the changelog.

Locally: `claude plugin validate --strict .` and `claude plugin test plugins/context-manager-skill`.

## Repository layout

```
.claude-plugin/marketplace.json              marketplace "llnet-inc-tools"
plugins/context-manager-skill/
  .claude-plugin/plugin.json                 manifest, version, plugin options
  hooks/hooks.json                           loads the mod
  hooks/register.tsx                         the hooks: prompt, compaction, turn end, tool, meter, picker, /context-manager
  hooks/core.ts                              settings, thresholds, options and text (pure logic)
  skills/prep-compact/SKILL.md               how Claude writes the handoff
  skills/configure/SKILL.md                  how Claude changes settings
  skills/plan-check/SKILL.md                 how Claude checks planned work against the budget
  tests/context-manager.test.ts              run with `claude plugin test`
.github/workflows/ci.yml                     validate + test on every push and PR
.github/workflows/release.yml                tag + GitHub release on a new version
scripts/update-and-enable-autoupdate.ps1     one-step update + auto-update for users
```

## License

[MIT](LICENSE) © 2026 LLnet Inc.
