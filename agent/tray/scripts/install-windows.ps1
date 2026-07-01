# install-windows.ps1 — build finch-tray.exe, install it under %LOCALAPPDATA%\Finch,
# and add Start-menu + Startup shortcuts (launch at login). Idempotent.
#
#   powershell -ExecutionPolicy Bypass -File agent\tray\scripts\install-windows.ps1
#   $env:FINCH_HUB="https://…"; powershell -ExecutionPolicy Bypass -File …\install-windows.ps1
#
# On Windows the system tray needs no CGo (systray uses win32 directly), so a plain
# Go toolchain is enough.
#
# Uninstall:
#   Remove-Item "$env:LOCALAPPDATA\Finch" -Recurse -Force
#   Remove-Item "$([Environment]::GetFolderPath('Startup'))\Finch.lnk"
#   Remove-Item "$([Environment]::GetFolderPath('Programs'))\Finch.lnk"
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir  = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$InstallDir = Join-Path $env:LOCALAPPDATA "Finch"
$Exe = Join-Path $InstallDir "finch-tray.exe"

Write-Host "-> building finch-tray.exe ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Push-Location $AgentDir
try {
  & go build -o $Exe ./tray
  if ($LASTEXITCODE -ne 0) { throw "go build failed" }
} finally {
  Pop-Location
}

# Optional dashboard hub baked into the shortcut args.
$Args = ""
if ($env:FINCH_HUB) { $Args = "-hub $($env:FINCH_HUB)" }

function New-Shortcut([string]$LinkPath) {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($LinkPath)
  $sc.TargetPath = $Exe
  $sc.Arguments  = $Args
  $sc.WorkingDirectory = $InstallDir
  $sc.IconLocation = $Exe
  $sc.Description = "Finch — publish local services"
  $sc.Save()
}

Write-Host "-> writing Start-menu + Startup shortcuts ..."
New-Shortcut (Join-Path ([Environment]::GetFolderPath("Programs")) "Finch.lnk")
New-Shortcut (Join-Path ([Environment]::GetFolderPath("Startup"))  "Finch.lnk")

Write-Host "-> launching ..."
if ($Args) { Start-Process $Exe -ArgumentList $Args } else { Start-Process $Exe }

Write-Host "OK installed Finch to $InstallDir - in the Start menu and at every login."
Write-Host "   Reads %USERPROFILE%\.finch\finch.yml."
