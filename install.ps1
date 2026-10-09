# Installs or updates Abotica on Windows with Docker Desktop.
#
#   irm https://raw.githubusercontent.com/codevision-ro/abotica/main/install.ps1 | iex
#
# Same steps as install.sh: checks Docker Desktop, downloads the compose file of the latest
# release, writes .env with fresh secrets on the first run and starts everything. Run it again to
# update: it keeps .env and moves ABOTICA_VERSION to the new release.
#
# Options, as environment variables set before the command (or as parameters when the script is
# run from a file):
#   ABOTICA_DOMAIN    public domain served over HTTPS by the bundled Caddy; empty: only this
#                     computer, on http://localhost:3000
#   ABOTICA_DIR       install folder; default %USERPROFILE%\abotica
#   ABOTICA_VERSION   release to install; default the latest
#   ABOTICA_YES=1     no questions
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 has.
param(
  [string]$Domain = $env:ABOTICA_DOMAIN,
  [string]$Dir = $env:ABOTICA_DIR,
  [string]$Version = $env:ABOTICA_VERSION,
  [switch]$Yes = ($env:ABOTICA_YES -eq "1")
)

$Repo = "codevision-ro/abotica"
$MinCompose = [version]"2.23.1"

# Run through `irm | iex`, `exit` would close the user's window, so errors are thrown and reported.
function Fail([string]$Message) { throw $Message }
function Say([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Invoke-Docker {
  & docker @args
  if ($LASTEXITCODE -ne 0) { Fail "docker $($args -join ' ') failed (exit code $LASTEXITCODE)." }
}

function Test-DockerRunning {
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Ensure-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget -and -not $Yes) {
      $answer = Read-Host "Docker Desktop is not installed. Install it now with winget? [Y/n]"
      if ($answer -eq "" -or $answer -match "^[Yy]") {
        & winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
        Fail "Docker Desktop was installed. Start it (a restart may be needed), finish its setup, then run this installer again."
      }
    }
    Fail "Docker Desktop is required: https://www.docker.com/products/docker-desktop/ . Install it, start it, then run this installer again."
  }

  if (-not (Test-DockerRunning)) {
    $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $desktop) {
      Say "Starting Docker Desktop"
      Start-Process $desktop | Out-Null
      for ($i = 0; $i -lt 60 -and -not (Test-DockerRunning); $i++) { Start-Sleep -Seconds 3 }
    }
    if (-not (Test-DockerRunning)) { Fail "Docker is installed but not running. Start Docker Desktop, then run this installer again." }
  }

  $raw = (& docker compose version --short 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $raw) { Fail "Docker Compose v2 is missing. Update Docker Desktop, then run this installer again." }
  $parsed = $null
  if (-not [version]::TryParse(($raw.Trim() -replace "^v", "" -replace "[-+].*$", ""), [ref]$parsed)) { Fail "Unknown Docker Compose version: $raw" }
  if ($parsed -lt $MinCompose) { Fail "Docker Compose $parsed is too old: $MinCompose or newer is needed. Update Docker Desktop." }
}

function Get-LatestVersion {
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest"
    return $release.tag_name
  } catch {
    Fail "Could not read the latest release of $Repo from GitHub. Set ABOTICA_VERSION to a release, e.g. 0.1.0."
  }
}

function New-Secret([int]$Bytes, [switch]$Hex) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buffer)
  $rng.Dispose()
  if ($Hex) { return (($buffer | ForEach-Object { $_.ToString("x2") }) -join "") }
  return [Convert]::ToBase64String($buffer)
}

# UTF-8 without a byte order mark and with LF line ends, which is what docker compose reads.
function Write-EnvFile([string]$Path, [string[]]$Lines) {
  $encoding = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, (($Lines -join "`n") + "`n"), $encoding)
}

function Read-EnvValue([string]$Key) {
  $line = Get-Content .env | Where-Object { $_ -like "$Key=*" } | Select-Object -First 1
  if ($line) { return $line.Substring($Key.Length + 1) }
  return ""
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $lines = @(Get-Content .env)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -like "$Key=*") { $lines[$i] = "$Key=$Value"; $found = $true }
  }
  if (-not $found) { $lines += "$Key=$Value" }
  Write-EnvFile (Join-Path (Get-Location) ".env") $lines
}

function New-EnvFile([string]$Version, [string]$Domain) {
  if ($Domain) {
    $appUrl = "https://$Domain"
    $preview = "PREVIEW_URL=https://preview.$Domain"
    $profiles = "https"
  } else {
    $appUrl = "http://localhost:3000"
    $preview = "# PREVIEW_URL=https://preview.abotica.example.com (default: http://preview.localhost:3100)"
    $profiles = ""
  }
  $lines = @(
    "# Abotica configuration, written by install.ps1. Restart after a change: docker compose up -d",
    "",
    "# Release of the images. The installer moves it on update.",
    "ABOTICA_VERSION=$Version",
    "",
    "# Public address. With a domain, the bundled Caddy (COMPOSE_PROFILES=https) serves it over HTTPS.",
    "ABOTICA_DOMAIN=$Domain",
    "APP_URL=$appUrl",
    "BETTER_AUTH_URL=$appUrl",
    "# Agents' previews at <code>.<host of this URL>; needs the DNS record *.preview.<domain>.",
    $preview,
    "# Optional services, comma separated: https, ollama.",
    "COMPOSE_PROFILES=$profiles",
    "",
    "# Secrets, generated on install. VAULT_KEY encrypts the keys saved in the UI: if it is lost or",
    "# changed, they can no longer be read.",
    "BETTER_AUTH_SECRET=$(New-Secret 32)",
    "VAULT_KEY=$(New-Secret 32)",
    "POSTGRES_PASSWORD=$(New-Secret 24 -Hex)",
    "",
    "# Creating the account needs this code, so nobody else can claim the instance before you do.",
    "# Sign-up closes on its own after the first account.",
    "SETUP_CODE=$(New-Secret 24 -Hex)",
    "ALLOW_SIGNUP=true"
  )
  Write-EnvFile (Join-Path (Get-Location) ".env") $lines
}

# A pg_dump into backups\ before the images change, written by the backup service (it has pg_dump,
# the password and backups\ mounted). Migrations only move forward, so this dump is the way back.
function Backup-BeforeUpdate([string]$OldVersion) {
  if (-not $OldVersion) { $OldVersion = "unknown" }
  $running = @(& docker compose ps --status running --services 2>$null)
  if ($running -notcontains "backup") {
    Write-Warning "The backup service is not running, so there is no backup before this update."
    return
  }
  $name = "pre-update-$OldVersion-$(Get-Date -Format 'yyyyMMdd-HHmmss').dump"
  Say "Backing up the database to backups\$name"
  & docker compose exec -T backup pg_dump -h postgres -U abotica -Fc abotica -f "/backups/$name"
  if ($LASTEXITCODE -ne 0) { Fail "The backup before the update failed, so nothing was changed. Check: docker compose logs postgres" }
}

# The number of agent runs executing now, or $null when it cannot be read.
function Get-RunningRuns {
  $raw = & docker compose exec -T postgres psql -U abotica -d abotica -tAc "select count(*) from runs where status = 'running'" 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $count = 0
  if (-not [int]::TryParse("$raw".Trim(), [ref]$count)) { return $null }
  return $count
}

# Agent runs executing now: the update restarts the worker, which gives them a short while to finish,
# then stops the rest and saves what they did so far. Asks to wait for them, continue or abort; with
# ABOTICA_YES=1, a warning. A count that cannot be read never blocks the update.
function Confirm-ActiveRuns {
  $running = @(& docker compose ps --status running --services 2>$null)
  if ($running -notcontains "worker") { return }
  $count = Get-RunningRuns
  while ($true) {
    if ($null -eq $count) {
      Write-Warning "Could not check for agent runs in progress; continuing."
      return
    }
    if ($count -eq 0) { return }
    if ($Yes) {
      Write-Warning "$count agent run(s) in progress: the update stops them and saves what they did so far."
      return
    }
    Write-Host ""
    Write-Host "$count agent run(s) in progress. The update restarts the worker: runs still going after a"
    Write-Host "short wait are stopped, and what they did so far is saved."
    $answer = Read-Host "Wait for them (up to 10 minutes), continue now or abort the update? [W/c/a]"
    if ($answer -match "^[Cc]") { return }
    if ($answer -match "^[Aa]") { Fail "Update aborted, nothing was changed." }
    Say "Waiting for the runs in progress to finish (Ctrl+C aborts the update)"
    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Seconds 5
      $count = Get-RunningRuns
      if ($null -eq $count -or $count -eq 0) { break }
    }
  }
}

function Wait-Healthy {
  $port = Read-EnvValue "WEB_PORT"
  if (-not $port) { $port = "3000" }
  for ($i = 0; $i -lt 180; $i++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$port/api/health"
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 5
  }
  Write-Warning "Abotica did not answer on port $port after 15 minutes. Check: cd $(Get-Location); docker compose ps; docker compose logs"
  return $false
}

function Install-Abotica {
  Say "Abotica installer"
  Ensure-Docker

  if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE "abotica" }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Set-Location $Dir

  if (-not $Version) { $Version = Get-LatestVersion }
  $Version = $Version -replace "^v", ""

  Say "Downloading Abotica $Version into $Dir"
  $download = Join-Path $Dir "docker-compose.yml.new"
  try {
    Invoke-WebRequest -UseBasicParsing -OutFile $download `
      -Uri "https://raw.githubusercontent.com/$Repo/v$Version/docker-compose.prod.yml"
  } catch {
    Fail "Release v$Version has no docker-compose.prod.yml."
  }
  # With the compose file still the installed one, so its services are the ones running.
  if (Test-Path .env) {
    Confirm-ActiveRuns
    Backup-BeforeUpdate (Read-EnvValue "ABOTICA_VERSION")
  }
  Move-Item -Force $download (Join-Path $Dir "docker-compose.yml")

  $fresh = $false
  if (Test-Path .env) {
    Say "Keeping the existing .env (update)"
    Set-EnvValue "ABOTICA_VERSION" $Version
  } else {
    if (-not $Domain -and -not $Yes) {
      Write-Host ""
      Write-Host "Domain for Abotica, e.g. abotica.example.com, when this computer is a server reachable"
      Write-Host "from the internet. Leave empty to use it only on this computer."
      $Domain = Read-Host "Domain"
    }
    $Domain = ($Domain -replace "^https?://", "" -replace "/.*$", "").Trim()
    New-EnvFile $Version $Domain
    $fresh = $true
  }

  Say "Pulling the images"
  Invoke-Docker compose pull --quiet --ignore-buildable
  # Into the worker's models volume, so memory search works from the first start; already there on updates.
  Say "Downloading the built-in embedding model (about 330 MB, the first time only)"
  & docker compose run --rm --no-deps -T worker node_modules/.bin/tsx src/download-embedding-model.ts
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "The embedding model could not be downloaded now; the worker downloads it when it starts."
  }
  Say "Starting Abotica (the first start builds the sandbox image, a few minutes)"
  Invoke-Docker compose up -d --remove-orphans

  $healthy = Wait-Healthy
  $appUrl = Read-EnvValue "APP_URL"
  Write-Host ""
  Say "Abotica $Version is running"
  if (-not $fresh) {
    Write-Host ""
    Write-Host "  Updated. Open $appUrl"
    return
  }
  $code = Read-EnvValue "SETUP_CODE"
  $signup = "$appUrl/signup"
  if ($code) { $signup = "$signup`?code=$code" }
  Write-Host ""
  Write-Host "  Create your account (the link carries the setup code, which only you have):"
  Write-Host ""
  Write-Host "    $signup"
  Write-Host ""
  Write-Host "  The first account is the only one. Then connect a model provider under"
  Write-Host "  Settings > Models."
  $d = Read-EnvValue "ABOTICA_DOMAIN"
  if ($d) {
    Write-Host ""
    Write-Host "  DNS: $d and *.preview.$d (agents' previews) must point to this computer,"
    Write-Host "  and ports 80 and 443 must be open."
  }
  Write-Host ""
  Write-Host "  Folder:   $Dir (docker-compose.yml, .env, backups\)"
  Write-Host "  Logs:     cd $Dir; docker compose logs -f"
  Write-Host "  Update:   run this installer again"
  Write-Host "  Telegram, Ollama and other settings: https://github.com/$Repo/blob/main/DEPLOY.md"
  if ($healthy -and -not $d) { Start-Process $signup | Out-Null }
}

$previousLocation = Get-Location
try {
  Install-Abotica
} catch {
  Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Set-Location $previousLocation
}
