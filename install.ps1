# Installs Auni on Windows, which runs it inside WSL (Windows Subsystem for Linux): Windows has no
# sandbox Auni can lock the agent's shell in, so Auni never runs on Windows itself.
#
#   irm https://raw.githubusercontent.com/jarrodwatts/auni/main/install.ps1 | iex
#
# With WSL, this runs install.sh inside it. Without, it says how to add WSL, then to run install.sh
# from Ubuntu.

$ErrorActionPreference = "Stop"
$installLine = "curl -fsSL https://raw.githubusercontent.com/jarrodwatts/auni/main/install.sh | sh"

# A Linux that runs a command: `wsl.exe` alone can be there with no Linux installed in it.
$hasLinux = $false
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
  wsl.exe -e true *> $null
  $hasLinux = $LASTEXITCODE -eq 0
}

if (-not $hasLinux) {
  Write-Host ""
  Write-Host "Auni runs inside WSL, which isn't set up on this PC yet."
  Write-Host ""
  Write-Host "1. Open PowerShell as administrator and run:"
  Write-Host ""
  Write-Host "     wsl --install"
  Write-Host ""
  Write-Host "2. Restart, open Ubuntu from the Start menu, then run this there:"
  Write-Host ""
  Write-Host "     $installLine"
  Write-Host ""
  # `return`, not `exit`: run through `iex`, exit would close the person's PowerShell window.
  return
}

Write-Host "Installing Auni inside WSL..."
wsl.exe -e sh -c $installLine
if ($LASTEXITCODE -ne 0) { return }
Write-Host ""
Write-Host "Open Ubuntu from the Start menu and run: auni"
