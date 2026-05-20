# Publishing

This repository is ready to be pushed to GitHub once a target repository exists.

## Recommended Repository Name

Use `compact-fallback-rescue`.

## Create The Remote Repository

Create a blank repository under your GitHub account or organization, then point the local repo at it:

```powershell
git -C "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue" remote add origin git@github.com:OWNER/compact-fallback-rescue.git
```

Replace `OWNER` with your GitHub login or organization name.

## Push

```powershell
git -C "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue" push -u origin master
```

If you prefer a main branch:

```powershell
git -C "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue" branch -M main
git -C "$env:USERPROFILE\.codex\plugins\compact-fallback-rescue" push -u origin main
```

## Release Archive

A zip archive is also generated at:

```powershell
$env:USERPROFILE\.codex\compact-fallback-rescue-release.zip
```

## What Not To Publish

Do not publish:

- `state/`
- `logs/`
- local session files
- any transcript contents

These files are ignored by git already.
