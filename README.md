# Compact Fallback Rescue

Compact Fallback Rescue is a local Codex plugin/sidecar that rescues selected Codex conversations after a remote compact failure.

It does not change `model_provider`, so existing Codex Desktop history remains visible.

## What It Does

For conversations that you explicitly enable, a local watcher follows the session transcript. When it sees a remote compact failure such as:

```text
Error running remote compact task: stream disconnected before completion
```

it runs two `codex exec resume` calls against the same session:

```powershell
codex exec resume <session_id> --model gpt-5.4-mini "继续"
codex exec resume <session_id> --model <original_model> "继续。刚才 gpt-5.4-mini 仅用于完成上下文压缩救援；现在请按本会话原模型继续执行最新用户请求。若这条消息插入在任务中间，请把它视为恢复信号，优先接上 compact 失败前正在处理的工作。"
```

The first resume gives Codex a chance to compact successfully with `gpt-5.4-mini`. The second resume switches back to the model that was recorded for the enabled session.

## Safety Model

- Opt-in per session.
- No provider switching.
- No request interception.
- No transcript contents are uploaded.
- Local state and logs are ignored by git.
- Best-effort automation: it watches transcript files and uses the local Codex CLI.

## Install

Copy or clone this plugin to:

```powershell
$env:USERPROFILE\.codex\plugins\compact-fallback-rescue
```

Install the hidden watcher startup task:

```powershell
& "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\install-startup.ps1"
```

The watcher starts immediately and again on login.

## Enable A Conversation

Run this from the workspace used by the conversation:

```powershell
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" enable --latest --cwd "$PWD"
```

For maximum precision, pass the transcript path directly:

```powershell
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" enable --transcript "$env:USERPROFILE\.codex\sessions\YYYY\MM\DD\rollout-....jsonl" --model gpt-5.5
```

## Status

```powershell
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" status
```

## Disable

Disable the newest session for the current workspace:

```powershell
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" disable --latest
```

Disable a specific session:

```powershell
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" disable --session-id <session_id>
```

Disable every recorded session:

```powershell
node "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\scripts\rescue.mjs" disable --all
```

## Stop Or Remove Watcher

```powershell
& "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue\stop.ps1"
Disable-ScheduledTask -TaskName CodexCompactFallbackRescueWatcher
```

To remove the startup task completely:

```powershell
Unregister-ScheduledTask -TaskName CodexCompactFallbackRescueWatcher -Confirm:$false
```

## Tests

```powershell
npm test
```

The tests use dry-run mode and do not call the Codex API.

## Limitations

This is not a core compact retry. It cannot rewrite `/responses/compact` requests. It is a sidecar that waits for a failure and then resumes the same session through the Codex CLI.

If Codex Desktop is actively writing the same session while the watcher resumes it, there is still a race risk. The watcher waits for the transcript to become quiet before acting, but this remains best-effort.
