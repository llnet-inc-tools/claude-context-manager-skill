---
name: status
description: Show whether Claude Context Manager Skill is active in this session, with its effective settings, current context size, handoff state and auto-compact trigger.
disable-model-invocation: true
---

# Context manager status

Run this command once with your shell tool, exactly as written:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/context-manager.ps1" status -SessionId "${CLAUDE_SESSION_ID}" -ProjectDir "${CLAUDE_PROJECT_DIR}" -DataDir "${CLAUDE_PLUGIN_DATA}"
```

Show the user its output as-is (it is already formatted markdown). Add nothing else unless a line starts with "Not confirmed" or contains "Note:"; in that case add one sentence on what to do about it. If the command fails, say so, quote the error, and suggest running `/hooks` to check the plugin's hooks.
