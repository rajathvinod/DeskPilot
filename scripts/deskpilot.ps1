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
# install
# ---------------------------------------------------------------------------------------------
function Invoke-Install {
  Write-Head "DeskPilot - install"

  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  $python = Get-Command python -ErrorAction SilentlyContinue
  $bash = Get-Command bash -ErrorAction SilentlyContinue

  if (-not $node) { Write-Bad "Node.js is missing - install Node 22 first"; return 1 }
  if (-not $npm) { Write-Bad "npm is missing"; return 1 }
  if (-not $python) { Write-Bad "Python is missing - install Python 3.12 first"; return 1 }
  if (-not $bash) { Write-Note "Git Bash not found: start/stop will not work until it is installed" }
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
  if (Get-Command bash -ErrorAction SilentlyContinue) { Write-Ok "Git Bash present" } else { Write-Bad "Git Bash missing (needed by start/stop)"; $problems++ }

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
  try { $code = Get-Json '/pair/code' } catch { Write-Bad "no answer from $Base - start the backend first"; return 1 }
  Write-Head "Pairing code"
  Write-Host "  $($code.code)" -ForegroundColor Green
  Write-Host "  expires $($code.expiresAt)  (single use, $( [int]($code.ttlSeconds / 60) ) minutes)"
  Write-Host ""
  Write-Host "  On the phone: PAIR THIS PHONE -> type the code -> Pair"
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
# `| Select-Object -Last 1` because these functions also let command output through (npm, pip);
# only their final value is the exit code.
switch ($Command.ToLower()) {
  'install' { exit ([int](Invoke-Install | Select-Object -Last 1)) }
  'doctor' { exit ([int](Invoke-Doctor | Select-Object -Last 1)) }
  'pair' { exit ([int](Invoke-Pair | Select-Object -Last 1)) }
  'devices' { exit ([int](Invoke-Devices | Select-Object -Last 1)) }
  'revoke' { exit ([int](Invoke-Revoke | Select-Object -Last 1)) }
  'status' { exit ([int](Invoke-Status | Select-Object -Last 1)) }
  { $_ -in 'start', 'stop', 'restart' } {
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    if (-not $bash) { Write-Bad "start/stop need Git Bash"; exit 1 }
    & bash (Join-Path $Root 'scripts/dev.sh') $Command.ToLower() @Rest
    exit $LASTEXITCODE
  }
  default {
    Write-Host "DeskPilot on the laptop"
    Write-Host ""
    Write-Host "  deskpilot install                 create what is missing (safe to re-run)"
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
