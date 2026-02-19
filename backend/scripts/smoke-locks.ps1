# backend/scripts/smoke-locks.ps1
# Manual contract smoke-test for lock behavior (PowerShell-safe)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:8080"
$noteId = 1
$sessionA = "sessionA"
$sessionB = "sessionB"

$maxWaitServerSeconds = 30
$maxWaitUnlockSeconds = 180

# Disable PowerShell progress rendering globally (prevents teal progress UI)
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$text) {
  Write-Host ""
  Write-Host $text
}

function Write-Status([string]$text) {
  # Overwrite the same line to look like a "docker-style" status line
  $pad = " " * 20
  Write-Host -NoNewline ("`r  {0}{1}" -f $text, $pad)
}

function Done-Status([string]$text) {
  Write-Host ("`r  {0}" -f $text)
}

function Invoke-Curl([string[]]$curlArguments) {
  # -sS: silent but show errors; avoids curl progress meter noise
  $allArgs = @("-sS") + $curlArguments
  return & curl.exe @allArgs
}

function Wait-For-Server([int]$timeoutSeconds) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($timeoutSeconds)
  $spinner = @("|","/","-","\")

  $i = 0
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    try {
      $healthRaw = Invoke-Curl @("$baseUrl/health")
      if ($healthRaw -and $healthRaw.Trim().Length -gt 0) {
        Done-Status "✅ Backend reachable at $baseUrl"
        return
      }
    } catch {
      # ignore and retry
    }

    $i = ($i + 1) % $spinner.Length
    Write-Status ("{0} Waiting for {1}/health ..." -f $spinner[$i], $baseUrl)
    Start-Sleep -Milliseconds 400
  }

  Done-Status ""
  throw "Backend not reachable at $baseUrl within ${timeoutSeconds}s. Start it first in another terminal: npm start (or npm run dev)."
}

function GetNotesRaw() {
  return Invoke-Curl @("$baseUrl/notes")
}

function GetNoteLockInfo([int]$noteId) {
  $notesRaw = GetNotesRaw
  if (-not $notesRaw -or $notesRaw.Trim().Length -eq 0) {
    throw "GET /notes returned empty response."
  }

  try {
    $notes = $notesRaw | ConvertFrom-Json
  } catch {
    Write-Host ""
    Write-Host "Could not parse GET /notes JSON. Raw response:"
    Write-Host $notesRaw
    throw
  }

  $note = $notes | Where-Object { $_.id -eq $noteId } | Select-Object -First 1
  if (-not $note) {
    Write-Host ""
    Write-Host "GET /notes response:"
    Write-Host $notesRaw
    throw "Note $noteId not found in GET /notes response. (DB likely not seeded or wrong DB configured.)"
  }

  return $note.lock
}

function Wait-Until-Unlocked([int]$noteId, [int]$timeoutSeconds) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($timeoutSeconds)
  $spinner = @("|","/","-","\")

  $i = 0
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $lock = GetNoteLockInfo $noteId

    if ($lock.isLocked -eq $false) {
      Done-Status "✅ Note $noteId is unlocked"
      return
    }

    $expiresAt = [DateTimeOffset]::Parse($lock.expiresAt)
    $remaining = ($expiresAt - [DateTimeOffset]::UtcNow).TotalSeconds
    $timeLeft = [Math]::Max(0, [int]([Math]::Ceiling($remaining)))

    $i = ($i + 1) % $spinner.Length
    Write-Status ("{0} Locked by {1} until {2}Z (remaining ~{3}s)" -f `
      $spinner[$i], `
      $lock.lockedBy, `
      $expiresAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss"), `
      $timeLeft)

    # Check more frequently near expiry
    $sleepSeconds = 2
    if ($timeLeft -le 5) { $sleepSeconds = 1 }
    Start-Sleep -Seconds $sleepSeconds
  }

  Done-Status ""
  throw "Timed out waiting for note $noteId to become unlocked. If this keeps happening, another session is likely renewing the lock (e.g., an open browser tab)."
}

function AcquireLock([string]$sessionId, [int]$noteId) {
  return Invoke-Curl @(
    "-i",
    "-X", "POST",
    "$baseUrl/notes/$noteId/lock",
    "-H", "x-session-id: $sessionId"
  )
}

function ReleaseLock([string]$sessionId, [int]$noteId) {
  return Invoke-Curl @(
    "-i",
    "-X", "DELETE",
    "$baseUrl/notes/$noteId/lock",
    "-H", "x-session-id: $sessionId"
  )
}

function PutJson([string]$sessionId, [int]$noteId, $payloadObject) {
  $json = ($payloadObject | ConvertTo-Json -Compress)
  $tempFile = New-TemporaryFile
  Set-Content -Path $tempFile -Value $json -Encoding UTF8

  try {
    return Invoke-Curl @(
      "-i",
      "-X", "PUT",
      "$baseUrl/notes/$noteId",
      "-H", "x-session-id: $sessionId",
      "-H", "Content-Type: application/json",
      "--data-binary", "@$tempFile"
    )
  } finally {
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
  }
}

# -------------------------
# Smoke test flow
# -------------------------

Write-Step "0) Wait for backend to be reachable (health check, up to $maxWaitServerSeconds seconds)"
Wait-For-Server $maxWaitServerSeconds

Write-Step "1) Ensure note is unlocked (wait up to $maxWaitUnlockSeconds seconds if needed)"
Wait-Until-Unlocked $noteId $maxWaitUnlockSeconds

Write-Step "2) Session A acquires lock (expect 200)"
AcquireLock $sessionA $noteId

Write-Step "3) Session B tries to acquire lock (expect 423)"
AcquireLock $sessionB $noteId

Write-Step "4) Session B tries to update (expect 423)"
PutJson $sessionB $noteId @{ content = "B should not update" }

Write-Step "5) Session A updates (expect 200)"
PutJson $sessionA $noteId @{ content = "Updated by A" }

Write-Step "6) Session A releases lock (expect 204)"
ReleaseLock $sessionA $noteId

Write-Step "7) Session B can now acquire lock (expect 200)"
AcquireLock $sessionB $noteId

Write-Host ""
Write-Host "✅ Smoke test PASSED"
