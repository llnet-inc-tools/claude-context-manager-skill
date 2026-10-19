---
name: prep-compact
description: Prepare for context compaction by writing a handoff file that captures the task's state, then offer the user the right next step. Use when a context-manager note says context is past the preparation threshold, when compaction was held for lack of a handoff, or when the user says prep for compaction or prepare to compact.
---

# Prepare for compaction

Compaction replaces the conversation with a summary, so anything not written down can be lost. Write a handoff that lets you, or a fresh session, pick the work back up with no other context.

## Where to write it

Use the handoff path given in the context-manager note. If there is no note (the user invoked this directly), write to `.claude/context-manager/handoffs/handoff-manual-<YYYYMMDD-HHmm>.md` in the project root, and tell the user that a manual handoff doesn't unlock the compaction gate; only the session's own handoff path does. Overwrite any earlier version at the same path.

## What to put in it

Keep it under about 1,500 words. Be specific: exact file paths, function names, commands, error messages, numbers. Skip anything that can be re-derived by reading the code.

```markdown
# Compaction handoff
Project: <project folder>  ·  Saved: <date and time>

## Goal
What the user is trying to achieve overall, in their words where possible.

## Current status
What's done, what's in progress, what was being done at this exact moment.

## Decisions and constraints
Choices made and why, things the user ruled out, preferences they stated in this session.

## Key files and locations
Paths touched or important to the task, with one line each on why.

## Open issues
Bugs, failing tests, unanswered questions, known risks.

## Next steps
Numbered, in order. The first one should be doable immediately after compaction.

## Watch out for
Gotchas discovered the hard way: commands that hang, flaky tests, approaches already tried and abandoned.

<!-- handoff-complete -->
```

The last line must be exactly `<!-- handoff-complete -->`, written only once everything else is in the file. Compaction is held until that line is present **and** the Goal, Current status and Next steps sections have real content (not "TBD"). The `/context-manager` command shows whether the handoff counts as saved.

## After writing: offer the user the right next step

Judge where the work stands, then call the context manager's tool (named in the context-manager note, `mcp__context-manager-skill__context_manager`) with `action: "offer"`, `kind: "handoff"`, a `situation`, and a one-sentence `reason` the user will read:

| Situation | When | Recommend |
|---|---|---|
| `mid_task` | Work continues normally | `auto`: keep going, compact at the threshold |
| `near_done` | The task is about finished, or the user is wrapping up | `fresh_session` |
| `delicate_step` | You are partway through a risky step (a migration, a large refactor, a half-applied change) | `finish_step` |
| `topic_switch` | The user is moving to something unrelated | `fresh_session` |

When the current task isn't finished, also pass `estimate_tokens`: roughly how much context the rest of it will add (see the cost table in the `plan-check` skill). If the rest is small, the plugin offers to raise this session's limit so the task can finish without a compaction.

Pass `recommended` only when you disagree with the default for that situation, for example `continue_fresh` when a long task remains and a clean context would serve it better than a compacted one.

Then follow the tool's result: it either says the options are shown as buttons (tell the user in one line what you recommend and why), or asks you to put the same options to the user with AskUserQuestion and then call the tool with `action: "run"` and their choice. Carry on with what the user asked unless they pick something that ends the turn.

If the tool isn't available (the options picker is off, or this is an older version), reply with one line instead:

> Handoff saved. Safe to compact: auto-compact will run at the threshold, or type /compact now.

If significant decisions are made after this and before compaction, update the handoff (keeping the marker as the last line).
