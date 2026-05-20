---
name: compact-fallback-rescue
description: Enable, disable, or inspect session-scoped compact failure rescue for Codex conversations. Use when the user asks to enable compact fallback rescue for this chat, auto-continue after compact failure, or switch to gpt-5.4-mini only for compact recovery.
---

# Compact Fallback Rescue

Use this skill only for managing the local rescue watcher. It must not alter `model_provider` or global model settings.

Plugin root:

```powershell
$env:USERPROFILE\.codex\plugins\compact-fallback-rescue
```

Commands:

```powershell
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" status
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" enable --latest --cwd "$PWD"
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" disable --latest
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" disable --all
```

Startup:

```powershell
& "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\install-startup.ps1"
```

Behavior:

- `enable --latest --cwd "$PWD"` arms only the newest Codex transcript/session for the current working directory.
- The watcher ignores all other conversations.
- On a matching compact failure, it waits for the transcript to settle, then runs:
  `codex exec resume <session_id> --model gpt-5.4-mini "继续"`
- If the fallback resume exits successfully, it runs another resume with the recorded original model and a restore prompt.
- Keep status output concise and mention that this is a best-effort sidecar, not a core request retry.
