# Changelog

All notable changes to Claude Context Manager Skill. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-10-19

### Added
- **Options picker.** After Claude saves a handoff, it judges where the work stands (mid-task, nearly done, partway through a risky step, switching topics) and the plugin offers the matching next steps, recommended one first: keep going, compact now, finish this step then compact, start a fresh session, continue in a fresh session, review the handoff, or snooze. Picking one runs it.
- **Pre-flight check.** When Claude creates a task list, gets a plan approved, or starts a large piece of work, it estimates whether the work fits before compaction. If not, the picker offers to raise this session's limit, continue in a fresh session, or go ahead anyway.
- **Raise this session's limit:** session-only thresholds sized to the estimate (shown as `this session` in `/context-manager`).
- **Continue in a fresh session:** saves the handoff if needed, clears the session, and sends the new session a prompt to continue from the handoff.
- The picker shows as buttons above the prompt (terminal and desktop app; number keys work too). In VS Code, Claude asks the same question with a multiple-choice prompt.
- `/context-manager options` shows the picker on demand; `/context-manager run <option>` runs one.
- `plan-check` skill, and settings `offer_options` and `preflight_check` (also plugin options).

## [2.0.0] - 2026-10-19

### Changed
- Rewritten as a Claude Code mod: the hooks run inside Claude Code itself instead of PowerShell scripts, so the plugin now works on **Windows, macOS and Linux**, in the terminal, the desktop app's Code tab and the IDE extensions.
- Compacts on its own once context reaches `compact_at` and the handoff is saved (turn off with `auto_compact: false`). The `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` environment variable is no longer needed.
- Status is now the built-in `/context-manager` command (no permission prompt). It replaces `/context-manager-skill:status`.

### Added
- Live context meter above the prompt (terminal and desktop app), e.g. `Context 142k / 1M (14%) · handoff due now`. Turn off with `show_meter: false`.
- Settings `auto_compact` and `show_meter`, also available as plugin options.
- MIT license, changelog, CI that validates and tests every change, and tagged releases.

### Removed
- `scripts/context-manager.ps1` and `scripts/set-autocompact.ps1`.

### Upgrading from 1.x
- Optional: remove the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` user environment variable if you set it for 1.x. It is harmless but no longer needed.
- Settings files (`.claude/context-manager.json`) and handoff folders carry over unchanged.

## [1.1.0] - 2026-10-19

### Added
- `/context-manager-skill:status` command showing whether the hooks are firing, context size, handoff state and effective settings.

## [1.0.0] - 2026-10-19

### Added
- First release: handoff before compaction, compaction gate, post-compaction restore, startup pointer, layered settings (Windows, PowerShell).

[2.1.0]: https://github.com/llnet-inc-tools/claude-context-manager-skill/releases/tag/context-manager-skill--v2.1.0
[2.0.0]: https://github.com/llnet-inc-tools/claude-context-manager-skill/releases/tag/context-manager-skill--v2.0.0
[1.1.0]: https://github.com/llnet-inc-tools/claude-context-manager-skill/commit/fb0cde5
[1.0.0]: https://github.com/llnet-inc-tools/claude-context-manager-skill/commit/fc592e7
