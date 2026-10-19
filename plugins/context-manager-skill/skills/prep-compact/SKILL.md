---
name: prep-compact
description: Prepare for context compaction by writing a handoff file that captures the task's state, then confirm it's ready. Use when a context-manager note says context is past the preparation threshold, when compaction was held for lack of a handoff, or when the user says prep for compaction or prepare to compact.
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

The last line must be exactly `<!-- handoff-complete -->`, written only once everything else is in the file. Compaction is held until that line is present. The `/context-manager` command shows whether the handoff counts as saved.

## After writing

Reply to the user with one line, for example:

> Handoff saved. Safe to compact: auto-compact will run at the threshold, or type /compact now.

Then continue with whatever the user asked for in the same turn. If significant decisions are made after this and before compaction, update the handoff (keeping the marker as the last line).
