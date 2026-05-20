# Architecture

Compact Fallback Rescue is a sidecar, not a network proxy.

## State Machine

```text
enabled session
  -> transcript contains remote compact failure
  -> wait until transcript is quiet
  -> resume same session with fallback model and "继续"
  -> if fallback resume exits 0, resume same session with original model and restore prompt
  -> mark failure fingerprint as handled
```

## Files

- `scripts/rescue.mjs`: CLI and watcher implementation.
- `start.ps1`: runs watcher in the foreground for a scheduled task.
- `stop.ps1`: stops watcher processes.
- `install-startup.ps1`: registers `CodexCompactFallbackRescueWatcher`.
- `state/sessions.json`: local opt-in state, ignored by git.
- `logs/watcher.log`: local watcher events, ignored by git.

## Why This Exists

Codex plugins and hooks do not currently provide a supported way to rewrite compact requests, set a compact-only model, or submit a user message from a hook. This package works around that boundary by using the Codex CLI's session resume feature.

## Risks

- A rescue may race with an active Codex Desktop turn. The watcher waits for the transcript to be quiet first.
- The fallback resume can still fail if `gpt-5.4-mini` is unavailable.
- The restore resume uses the model recorded from the enabled session. If the user changes models later, disable and re-enable the session to refresh it.
