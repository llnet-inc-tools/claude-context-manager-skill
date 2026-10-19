---
name: plan-check
description: Before starting a large or multi-step piece of work (several files or tasks, a migration, a long checklist, a plan the user just approved), check whether it will fit in the context left before compaction, and if not, offer the user options. Also use when the user asks whether a task will fit, or to check the context budget.
---

# Check planned work against the context budget

1. **Find the room.** The context manager's budget note gives the current context size and the compaction threshold. Without one, run `/context-manager` or call the tool with `action: "offer"`; its result reports the numbers.
2. **Estimate the work** in tokens of context it will add. Count what you will read and write, not just the final diff:

   | Activity | Rough cost |
   |---|---|
   | Reading a source file | about 1k tokens per 100 lines |
   | Editing a file | the edit, plus re-reading the parts you change |
   | Running tests or builds | 1–5k per run, more for verbose output |
   | Searching a codebase | 1–3k per search |
   | Each back-and-forth with the user | 1–2k |

   Round up. Allow about 20% for surprises.
3. **If it fits**, start the work without mentioning the check.
4. **If it won't fit**, call the context manager's tool (`mcp__context-manager-skill__context_manager`) with `action: "offer"`, `kind: "preflight"`, `situation: "preflight_overflow"`, `estimate_tokens` (your estimate) and a one-sentence `reason` (for example "Refactoring 12 services needs about 220k; 30k is left."). Follow its result, and **don't start the work until the user has chosen**:
   - **Raise this session's limit:** the work fits the model's window; this session's thresholds go up, and you then go ahead.
   - **Continue in a fresh session:** a handoff is saved, the session is cleared, and the new session is asked to continue from the handoff.
   - **Go ahead:** start anyway; compaction happens when needed.
