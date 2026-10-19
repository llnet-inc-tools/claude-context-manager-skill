# Claude Context Manager Skill (Claude Code plugin, Windows)

Stops compaction from catching you off guard:

1. **Prepare** at 130k tokens: Claude writes a handoff (goal, status, decisions, files, next steps) and confirms it in one line.
2. **Gate** below 150k, or until the handoff is complete, auto-compaction is held. Above 300k it always runs (safety valve).
3. **Restore** right after compaction: the handoff is fed back to Claude automatically.
4. **Carry over** to new sessions: a fresh session in the same project is pointed at the latest handoff.

Handoffs are saved in `<project>/.claude/context-manager/handoffs/` (git-ignored automatically).

## Install

Paste this into any Claude Code session (Windows, Claude Code 2.1.275 or later):

```
/plugin install context-manager-skill --marketplace llnet-inc-tools/claude-context-manager-skill
```

Choose **user** scope for every project or **project** scope for one repo, then ask Claude:

```
/context-manager-skill:configure set the auto-compact trigger to 150k
```

and fully restart Claude. **[INSTALL.md](INSTALL.md)** has the desktop-app and terminal steps, a quick way to test it, and troubleshooting.

## Configure

Ask Claude in plain language, for example:

- `/context-manager-skill:status` (current settings and where each comes from)
- `/context-manager-skill:configure for this project, prep at 250k and compact at 280k`
- `/context-manager-skill:configure turn it off for this project`

Settings layer like this, highest priority first:

| Layer | File |
|---|---|
| Project | `<project>/.claude/context-manager.json` |
| All projects | `%USERPROFILE%\.claude\context-manager.json` |
| Plugin options | **+ → Plugins → Manage plugins → Claude Context Manager Skill → Configure options** |
| Defaults | prep 130k · compact 150k · safety 300k |

Keys: `enabled`, `prep_at`, `compact_at`, `force_at`, `gate_manual`, `offer_on_startup`, `handoff_dir`. Numbers can be `150000` or `"150k"`.

## Manual commands

- `/context-manager-skill:status`: confirm it's active in this session and show its effective settings
- `/context-manager-skill:prep-compact`: write a handoff now
- `/compact` without a handoff is blocked once; run it again within 2 minutes to force it

## Update

**+ → Plugins → Manage plugins**, or `/plugin` → **Marketplaces** → `llnet-inc-tools` → **Update marketplace**. To get updates automatically, turn on **Enable auto-update** for that marketplace. Bump `version` in `plugins/context-manager-skill/.claude-plugin/plugin.json` with each release so installs pick it up.

## Repository layout

```
.claude-plugin/marketplace.json           marketplace "llnet-inc-tools"
plugins/context-manager-skill/
  .claude-plugin/plugin.json              manifest + configurable options
  hooks/hooks.json                        UserPromptSubmit, PreCompact, SessionStart hooks
  scripts/context-manager.ps1             the hook logic
  scripts/set-autocompact.ps1             sets the auto-compact trigger
  skills/prep-compact/SKILL.md            writes the handoff
  skills/configure/SKILL.md               changes settings
  skills/status/SKILL.md                  shows status and effective settings
```

## Uninstall

**+ → Plugins → Manage plugins → Claude Context Manager Skill → Uninstall.** To clear the auto-compact trigger, ask Claude to run `set-autocompact.ps1 -Clear`, or delete the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` user environment variable.
