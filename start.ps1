$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Watcher = Join-Path $ScriptDir 'scripts\rescue.mjs'
$Node = (Get-Command node.exe -ErrorAction Stop).Source

$EscapedWatcher = $Watcher.Replace('\', '\\')
$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$EscapedWatcher*" -or $_.CommandLine -like "*rescue.mjs*watch*" }

if ($existing) {
    return
}

& $Node $Watcher watch
