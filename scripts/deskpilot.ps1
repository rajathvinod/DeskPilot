<#
.SYNOPSIS
  DeskPilot on the laptop: install, run, pair, inspect.

.DESCRIPTION
  One entry point for the laptop side of the project, so a new machine does not need three
  terminals and a hand-edited .env.

  Two rules shaped this script:

    * It never overwrites a file you already have. `install` creates what is missing and says what
      it skipped; re-running it is how you check, not how you reset.
    * It needs nothing but PowerShell and Git Bash. Talking to the backend is plain HTTP, so
      `status`, `doctor`, `pair`, `devices` and `revoke` work even when the code is stale.

.EXAMPLES
  ./deskpilot.cmd install
  ./deskpilot.cmd doctor
  ./deskpilot.cmd start --dev-client
  ./deskpilot.cmd pair
  ./deskpilot.cmd devices
  ./deskpilot.cmd revoke --stale
#>
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendPort = if ($env:DP_BACKEND_PORT) { [int]$env:DP_BACKEND_PORT } else { 8787 }
$Base = "http://127.0.0.1:$BackendPort"

function Write-Head($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  ok    $text" -ForegroundColor Green }
function Write-Bad($text) { Write-Host "  fail  $text" -ForegroundColor Red }
function Write-Note($text) { Write-Host "  note  $text" -ForegroundColor Yellow }

function Get-LanAddress {
  # The address the phone should use. Tailscale wins when present, because it works from anywhere;
  # otherwise the first private IPv4 on a real adapter.
  $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress
  $tailnet = $addresses | Where-Object { $_ -like '100.*' } | Select-Object -First 1
  if ($tailnet) { return $tailnet }
  $private = $addresses | Where-Object { $_ -match '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.' } | Select-Object -First 1
  if ($private) { return $private }
  return $null
}

function Resolve-Bash {
  # Git for Windows ships bash.exe in <install>\bin, but its installer only adds <install>\cmd to
  # PATH - so `git` works on a normal machine while `bash` does not. Asking the registry where Git
  # was installed is the honest fix; guessing install folders is how this breaks on the next PC.
  $candidates = @()
  $registry = Get-ItemProperty 'HKLM:\SOFTWARE\GitForWindows' -ErrorAction SilentlyContinue
  if ($registry -and $registry.InstallPath) {
    $candidates += (Join-Path $registry.InstallPath 'bin\bash.exe')
  }
  $onPath = Get-Command bash -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $candidates += @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\@codebufffreebuff-desktop\resources\git\bin\bash.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Test-Http($url) {
  try {
    $response = Invoke-WebRequest -Uri $url -TimeoutSec 4 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-Json($path) {
  return Invoke-RestMethod -Uri "$Base$path" -TimeoutSec 6
}

function New-AgentToken {
  # RNGCryptoServiceProvider, not RandomNumberGenerator.Fill: this has to run on Windows
  # PowerShell 5.1 (the one that ships with Windows), which is .NET Framework.
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Get-EnvValue($file, $key) {
  if (-not (Test-Path $file)) { return $null }
  foreach ($line in Get-Content $file) {
    if ($line -match "^\s*$([regex]::Escape($key))=(.*)$") { return $Matches[1].Trim() }
  }
  return $null
}

function Add-EnvValue($file, $key, $value) {
  Add-Content -Path $file -Value "$key=$value" -Encoding utf8
}

# ---------------------------------------------------------------------------------------------
# autostart
# ---------------------------------------------------------------------------------------------
function Set-Autostart {
  # A per-user Run key, not a service: starting the agent at login must not need admin rights, and
  # removing it is deleting one value. The launcher is hidden because a console window that flashes
  # on every login is the kind of thing people disable instead of using.
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $script = Join-Path $Root 'scripts/deskpilot.ps1'
  $quote = [char]34
  $command = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' +
    $quote + $script + $quote + ' start --no-mobile'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name 'DeskPilot' -Value $command
  Write-Ok 'autostart installed: HKCU Run -> DeskPilot (backend + agent at login)'
}

function Remove-Autostart {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $existing = Get-ItemProperty -Path $key -Name 'DeskPilot' -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Note 'autostart was not installed'
    return
  }
  Remove-ItemProperty -Path $key -Name 'DeskPilot'
  Write-Ok 'autostart removed'
}

# ---------------------------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------------------------
function Invoke-Install {
  Write-Head "DeskPilot - install"

  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  $python = Get-Command python -ErrorAction SilentlyContinue
  $bash = Resolve-Bash

  if (-not $node) { Write-Bad "Node.js is missing - install Node 22 first"; return 1 }
  if (-not $npm) { Write-Bad "npm is missing"; return 1 }
  if (-not $python) { Write-Bad "Python is missing - install Python 3.12 first"; return 1 }
  if ($bash) { Write-Ok "bash $($bash)" } else { Write-Note "Git Bash not found: start/stop needs it (install Git for Windows)" }
  Write-Ok "node $(& node --version), python $(& python --version 2>&1)"

  # Backend dependencies. `npm ci` when a lockfile exists: reproducible, and it is what the
  # checked-in lockfile is for.
  if (-not (Test-Path (Join-Path $Root 'backend/node_modules'))) {
    Write-Host "  installing backend dependencies..."
    Push-Location (Join-Path $Root 'backend')
    try { & npm ci --omit=dev; if ($LASTEXITCODE -ne 0) { & npm install } } finally { Pop-Location }
  }
  Write-Ok "backend dependencies present"

  # Agent virtualenv. Kept out of the system Python on purpose: this is the process that reads the
  # screen, so it should be the easiest thing to delete and rebuild.
  $venv = Join-Path $Root 'agent/.venv'
  if (-not (Test-Path $venv)) {
    Write-Host "  creating the agent virtualenv..."
    & python -m venv $venv
    & (Join-Path $venv 'Scripts/python.exe') -m pip install --quiet --upgrade pip
    & (Join-Path $venv 'Scripts/python.exe') -m pip install --quiet -r (Join-Path $Root 'agent/requirements.txt')
    if ($LASTEXITCODE -ne 0) { Write-Bad "pip install failed"; return 1 }
  }
  Write-Ok "agent virtualenv present"

  # Configuration. Generated token, detected address, existing files left alone.
  $backendEnv = Join-Path $Root 'backend/.env'
  $agentEnv = Join-Path $Root 'agent/.env'
  $mobileEnv = Join-Path $Root 'mobile/.env'

  $token = Get-EnvValue $backendEnv 'DP_AGENT_TOKEN'
  if (-not $token) { $token = Get-EnvValue $agentEnv 'DP_AGENT_TOKEN' }
  if (-not $token) { $token = New-AgentToken; Write-Ok "generated a new DP_AGENT_TOKEN" }

  foreach ($pair in @(
      @{ File = $backendEnv; Example = 'backend/.env.example'; Token = $true; Address = $false },
      @{ File = $agentEnv; Example = 'agent/.env.example'; Token = $true; Address = $false }
    )) {
    if (-not (Test-Path $pair.File)) {
      Copy-Item (Join-Path $Root $pair.Example) $pair.File
      Write-Ok "created $($pair.File) from the example"
    }
    if ($pair.Token -and -not (Get-EnvValue $pair.File 'DP_AGENT_TOKEN')) {
      Add-EnvValue $pair.File 'DP_AGENT_TOKEN' $token
      Write-Ok "wrote DP_AGENT_TOKEN into $($pair.File)"
    }
  }

  $lan = Get-LanAddress
  if (-not (Test-Path $mobileEnv)) {
    Copy-Item (Join-Path $Root 'mobile/.env.example') $mobileEnv
    Write-Ok "created mobile/.env from the example"
  }
  if (-not (Get-EnvValue $mobileEnv 'EXPO_PUBLIC_API_URL') -and $lan) {
    # Rewrite the placeholder rather than appending a second value: the first match wins in
    # everything that reads this file, so an appended line would be silently ignored.
    $contents = Get-Content $mobileEnv
    $replaced = $false
    for ($i = 0; $i -lt $contents.Count; $i++) {
      if ($contents[$i] -match '^EXPO_PUBLIC_API_URL=') {
        $contents[$i] = "EXPO_PUBLIC_API_URL=http://${lan}:$BackendPort"
        $replaced = $true
      }
    }
    if (-not $replaced) { $contents += "EXPO_PUBLIC_API_URL=http://${lan}:$BackendPort" }
    Set-Content -Path $mobileEnv -Value $contents -Encoding utf8
    Write-Ok "pointed mobile/.env at http://${lan}:$BackendPort"
  }

  if (-not $lan) { Write-Note "could not detect a LAN address - set EXPO_PUBLIC_API_URL in mobile/.env by hand" }

  if ($Rest -contains '--autostart') { Set-Autostart }
  elseif ($Rest -contains '--remove-autostart') { Remove-Autostart }

  Write-Head "Next"
  Write-Host "  1. ./deskpilot.cmd start --dev-client"
  Write-Host "  2. ./deskpilot.cmd pair          (type the code into the phone)"
  Write-Host "  3. ./deskpilot.cmd status"
  return 0
}

# ---------------------------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------------------------
function Invoke-Doctor {
  Write-Head "DeskPilot - doctor"
  $problems = 0

  if (Get-Command node -ErrorAction SilentlyContinue) { Write-Ok "node $(& node --version)" } else { Write-Bad "node is missing"; $problems++ }
  if (Get-Command python -ErrorAction SilentlyContinue) { Write-Ok "python $(& python --version 2>&1)" } else { Write-Bad "python is missing"; $problems++ }
  $bash = Resolve-Bash
  if ($bash) { Write-Ok "Git Bash: $bash" } else { Write-Bad "Git Bash missing (needed by start/stop)"; $problems++ }

  $venvPython = Join-Path $Root 'agent/.venv/Scripts/python.exe'
  if (Test-Path $venvPython) { Write-Ok "agent virtualenv present" } else { Write-Bad "agent virtualenv missing - run install"; $problems++ }

  foreach ($pair in @(
      @{ Name = 'backend/.env'; What = 'backend configuration' },
      @{ Name = 'agent/.env'; What = 'agent configuration' },
      @{ Name = 'mobile/.env'; What = 'phone configuration' }
    )) {
    if (Test-Path (Join-Path $Root $pair.Name)) { Write-Ok $pair.What } else { Write-Bad "$($pair.What) missing - run install"; $problems++ }
  }

  # Token agreement, without printing either value.
  $backendToken = Get-EnvValue (Join-Path $Root 'backend/.env') 'DP_AGENT_TOKEN'
  $agentToken = Get-EnvValue (Join-Path $Root 'agent/.env') 'DP_AGENT_TOKEN'
  if ($backendToken -and $agentToken) {
    if ($backendToken -eq $agentToken) { Write-Ok "DP_AGENT_TOKEN matches on both sides" }
    else { Write-Bad "DP_AGENT_TOKEN differs: the agent's socket will be refused with 4003"; $problems++ }
  } else {
    Write-Note "DP_AGENT_TOKEN unset on at least one side - the agent socket accepts anyone who can reach it"
  }

  if (Test-Http "$Base/health") {
    Write-Ok "backend answers on $Base"
    try {
      $health = Get-Json '/health'
      Write-Ok ("agent connected: {0}" -f $health.agentsConnected)
      Write-Ok ("paired devices: {0}, suspended: {1}" -f $health.auth.pairedDevices, $health.auth.suspended)
      Write-Ok ("agent socket: {0}" -f $health.auth.agentSocket)
      if ($health.auth.agentSocket -eq 'open') { Write-Note "set DP_AGENT_TOKEN to close the agent socket" }
    } catch {
      Write-Note "backend answered but /health could not be read"
    }
  } else {
    Write-Bad "backend is not answering on $Base - ./deskpilot.cmd start --no-mobile"; $problems++
  }

  if (Test-Http 'http://127.0.0.1:8788/health') { Write-Ok "agent answers on :8788" } else { Write-Bad "agent is not answering on :8788"; $problems++ }

  $lan = Get-LanAddress
  if ($lan) { Write-Ok "phone should use http://${lan}:$BackendPort" } else { Write-Note "no LAN/tailnet address detected" }

  Write-Head $(if ($problems -eq 0) { "doctor: everything checks out" } else { "doctor: $problems problem(s) above" })
  if ($problems -gt 0) { return 1 } else { return 0 }
}

# ---------------------------------------------------------------------------------------------
# Everything that is just the backend's own routes
# ---------------------------------------------------------------------------------------------
function Invoke-Pair {
  $wantQr = $Rest -contains '--qr'
  $path = if ($wantQr) { '/pair/qr' } else { '/pair/code' }
  try { $minted = Get-Json $path } catch { Write-Bad "no answer from $Base - start the backend first"; return 1 }

  Write-Head "Pairing code"
  Write-Host "  $($minted.code)" -ForegroundColor Green
  Write-Host "  expires $($minted.expiresAt)  (single use, $([int]($minted.ttlSeconds / 60)) minutes)"

  if ($wantQr) {
    # Rendered by qrcode-terminal in backend/node_modules - one small dependency, no native side,
    # so the terminal can show what the phone's new scanner reads.
    $render = "const qr = require('qrcode-terminal'); qr.generate(process.argv[1], { small: true });"
    Push-Location (Join-Path $Root 'backend')
    # Out-Host, so the QR prints here rather than being collected and flushed after the hints.
    try { & node -e $render $minted.payload | Out-Host } finally { Pop-Location }
    Write-Host "  On the phone: PAIR THIS PHONE -> Scan QR"
  } else {
    Write-Host "  On the phone: PAIR THIS PHONE -> type the code -> Pair"
  }

  if ($minted.url) { Write-Host "  the phone should reach the backend at $($minted.url)" }
  return 0
}

function Invoke-Devices {
  try { $body = Get-Json '/local/devices' } catch { Write-Bad "no answer from $Base (or this is not the laptop)"; return 1 }
  $live = @($body.devices | Where-Object { -not $_.revokedAt })
  $revoked = @($body.devices | Where-Object { $_.revokedAt })
  Write-Head ("Devices - {0} live, {1} revoked" -f $live.Count, $revoked.Count)
  foreach ($device in $live) {
    Write-Host ("  {0,-18} {1}  paired {2}" -f $device.name, $device.deviceId, $device.pairedAt)
  }
  if ($Rest -contains '-a' -or $Rest -contains '--all') {
    foreach ($device in $revoked) {
      Write-Host ("  - {0,-17} {1}  revoked {2}" -f $device.name, $device.deviceId, $device.revokedAt) -ForegroundColor DarkGray
    }
  }
  return 0
}

function Invoke-Revoke {
  $target = if ($Rest.Count -gt 0) { $Rest[0] } else { '' }
  if (-not $target) { Write-Bad "usage: revoke <deviceId> | revoke --stale"; return 1 }
  try { $body = Get-Json '/local/devices' } catch { Write-Bad "no answer from $Base"; return 1 }
  $live = @($body.devices | Where-Object { -not $_.revokedAt })

  if ($target -eq '--stale') {
    # Same rule as the shell script: a live device is stale only when another live device with the
    # same name was seen more recently - what re-pairing the same phone looks like.
    $newest = @{}
    foreach ($device in $live) {
      $stamp = if ($device.lastSeenAt) { $device.lastSeenAt } else { $device.pairedAt }
      $seen = [DateTime]::Parse($stamp)
      if (-not $newest.ContainsKey($device.name) -or $seen -gt $newest[$device.name].Seen) {
        $newest[$device.name] = @{ Id = $device.deviceId; Seen = $seen }
      }
    }
    $victims = @($live | Where-Object { $newest[$_.name].Id -ne $_.deviceId })
    if ($victims.Count -eq 0) { Write-Ok "nothing stale"; return 0 }
  } else {
    $victims = @($live | Where-Object { $_.deviceId -eq $target })
    if ($victims.Count -eq 0) { Write-Bad "no live device $target"; return 1 }
  }

  foreach ($device in $victims) {
    try {
      Invoke-RestMethod -Method Delete -Uri "$Base/local/devices/$($device.deviceId)" -TimeoutSec 6 | Out-Null
      Write-Ok "revoked $($device.name) ($($device.deviceId))"
    } catch {
      Write-Bad "could not revoke $($device.name)"
    }
  }
  return 0
}

function Invoke-Status {
  Write-Head "DeskPilot - status"
  if (-not (Test-Http "$Base/health")) {
    Write-Bad "backend is not answering on $Base"
    return 1
  }
  $health = Get-Json '/health'
  Write-Ok ("backend up {0}m, version {1}" -f [int]($health.uptimeSeconds / 60), $health.version)
  Write-Ok ("agents connected: {0}" -f $health.agentsConnected)
  Write-Ok ("paired devices: {0}, suspended: {1}, agent socket: {2}" -f $health.auth.pairedDevices, $health.auth.suspended, $health.auth.agentSocket)
  if (Test-Http 'http://127.0.0.1:8788/health') { Write-Ok "agent answering on :8788" } else { Write-Bad "agent not answering on :8788" }
  try {
    $graph = Get-Json '/local/devices'
    $live = @($graph.devices | Where-Object { -not $_.revokedAt })
    Write-Ok ("device records: {0} live" -f $live.Count)
  } catch { }
  return 0
}

# ---------------------------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------------------------
# These functions both print and return a number, and the number is the exit code. Anything that
# goes through the *pipeline* (npm, pip, the QR renderer) has to be shown explicitly: capturing
# the return value with Select-Object -Last 1 would discard it, which is how `pair --qr` printed
# the code and no QR at all.
function Show-AndGetExitCode($result) {
  $items = @($result)
  if ($items.Count -gt 1) { $items[0..($items.Count - 2)] | ForEach-Object { Write-Host $_ } }
  if ($items.Count -eq 0) { return 0 }
  return [int]$items[-1]
}

switch ($Command.ToLower()) {
  'install' { exit (Show-AndGetExitCode (Invoke-Install)) }
  'doctor' { exit (Show-AndGetExitCode (Invoke-Doctor)) }
  'pair' { exit (Show-AndGetExitCode (Invoke-Pair)) }
  'devices' { exit (Show-AndGetExitCode (Invoke-Devices)) }
  'revoke' { exit (Show-AndGetExitCode (Invoke-Revoke)) }
  'status' { exit (Show-AndGetExitCode (Invoke-Status)) }
  { $_ -in 'start', 'stop', 'restart' } {
    $bash = Resolve-Bash
    if (-not $bash) { Write-Bad "start/stop need Git Bash (install Git for Windows)"; exit 1 }
    # Redirect to files and wait for the launcher only. The services dev.sh backgrounds inherit
    # this console's handles, so a bare `& bash dev.sh start` leaves PowerShell waiting for output
    # that arrives only when the backend exits - the command looks hung while the stack is
    # actually up. Redirecting ends that wait; the tail below still shows what dev.sh said.
    $logDir = Join-Path $Root 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $outFile = Join-Path $logDir 'deskpilot-cli.out'
    $errFile = Join-Path $logDir 'deskpilot-cli.err'

    # Resolved path, not a bare `bash`: a stock Git install keeps bash.exe off PATH even though
    # git is on it, and "bash is not recognized" is a confusing way to learn that.
    $arguments = @((Join-Path $Root 'scripts/dev.sh'), $Command.ToLower()) + $Rest
    $quoted = $arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }

    # With Expo in the foreground there is nothing to wait for and nothing to hide: the QR has to
    # reach this console, and Ctrl-C has to stop all three. Anything else is "background", where
    # the useful signal is the backend answering, not the launcher exiting - dev.sh keeps a
    # supervising shell around the services, so waiting on it would just look like a hang.
    $wantsMobile = -not ($Rest -contains '--no-mobile')
    if ($Command.ToLower() -eq 'stop' -or $wantsMobile) {
      & $bash @arguments
      exit $LASTEXITCODE
    }

    $process = Start-Process -FilePath $bash -ArgumentList ($quoted -join ' ') `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile

    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not (Test-Http "$Base/health")) { Start-Sleep -Milliseconds 500 }

    if (Test-Path $outFile) { Get-Content $outFile | ForEach-Object { Write-Host $_ } }
    if (Test-Path $errFile) {
      Get-Content $errFile | Where-Object { $_ } | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
    }

    if (Test-Http "$Base/health") { Write-Ok "backend answered - ready" ; exit 0 }
    Write-Bad "backend did not answer within 90s - see logs/backend.log"
    exit 1
    exit $LASTEXITCODE
  }
  default {
    Write-Host "DeskPilot on the laptop"
    Write-Host ""
    Write-Host "  deskpilot install                 create what is missing (safe to re-run)"
    Write-Host "  deskpilot install --autostart     also start backend + agent at login"
    Write-Host "  deskpilot install --remove-autostart"
    Write-Host "  deskpilot doctor                  check the setup, without changing it"
    Write-Host "  deskpilot start [--no-mobile] [--dev-client]"
    Write-Host "  deskpilot stop | restart"
    Write-Host "  deskpilot status"
    Write-Host "  deskpilot pair                    print a pairing code"
    Write-Host "  deskpilot devices [-a]"
    Write-Host "  deskpilot revoke <id> | --stale"
    Write-Host ""
    Write-Host "  Add this folder to PATH to run it as 'deskpilot'."
    exit 0
  }
}
