# Manual contract smoke-test for lock behavior (PowerShell-safe)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$baseUrl = "http://localhost:8080"
$noteId = 1
$sessionA = "sessionA"
$sessionB = "sessionB"

$maxWaitServerSeconds = 30
$maxWaitUnlockSeconds = 180

function Write-Step([string]$text) {
  Write-Host ""
  Write-Host $text
}

function Write-Status([string]$text) {
  $pad = " " * 20
  Write-Host -NoNewline ("`r  {0}{1}" -f $text, $pad)
}

function Done-Status([string]$text) {
  Write-Host ("`r  {0}" -f $text)
}

function Invoke-Curl([string[]]$curlArguments) {
  # -sS: silent but show errors; avoids progress meter noise
  $allArgs = @("-sS") + $curlArguments
  return & curl.exe @allArgs
}

function Parse-HttpStatus([string]$raw) {
  # raw contains headers when -i is used
  $m = [regex]::Match($raw, "HTTP\/\d\.\d\s+(?<code>\d{3})")
  if (-not $m.Success) { throw "Could not parse HTTP status from response." }
  return [int]$m.Groups["code"].Value
}

function Assert-Status([string]$raw, [int]$expected, [string]$label) {
  $code = Parse-HttpStatus $raw
  if ($code -ne $expected) {
    Write-Host ""
    Write-Host "FAILED: $label"
    Write-Host "Expected: $expected, got: $code"
    Write-Host ""
    Write-Host $raw
    throw "$label failed with HTTP $code"
  }
}

function Normalize-UtcIso([string]$rawTimestamp) {
  if (-not $rawTimestamp) { return $null }

  $t = $rawTimestamp.Trim()

  # Already has timezone
  if ($t -match "([zZ]$|[+-]\d{2}:\d{2}$)") { return $t }

  # MySQL DATETIME "YYYY-MM-DD HH:mm:ss" => treat as UTC
  if ($t -match "^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$") {
    return ($t -replace " ", "T") + "Z"
  }

  # ISO without timezone => treat as UTC
  if ($t -match "^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$") {
    return $t + "Z"
  }

  return $t
}

function Wait-For-Server([int]$timeoutSeconds) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($timeoutSeconds)
  $spinner = @("|","/","-","\")

  $i = 0
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    try {
      $healthRaw = Invoke-Curl @("$baseUrl/health")
      if ($healthRaw -and $healthRaw.Trim().Length -gt 0) {
        Done-Status "Backend reachable at $baseUrl"
        return
      }
    } catch { }

    $i = ($i + 1) % $spinner.Length
    Write-Status ("{0} Waiting for {1}/health ..." -f $spinner[$i], $baseUrl)
    Start-Sleep -Milliseconds 400
  }

  Done-Status ""
  throw "Backend not reachable at $baseUrl within ${timeoutSeconds}s. Start it first in another terminal."
}

function Try-Reset-Locks() {
  # Only works if backend enables it (NODE_ENV=test or E2E=1)
  try {
    $raw = Invoke-Curl @(
      "-i",
      "-X", "POST",
      "$baseUrl/__test__/reset"
    )
    $code = Parse-HttpStatus $raw
    if ($code -eq 200) {
      Done-Status "Reset endpoint available: cleared note_locks"
      return $true
    }
    return $false
  } catch {
    return $false
  }
}

function GetNotesRaw() {
  return Invoke-Curl @("$baseUrl/notes")
}

function GetNoteLockInfo([int]$id) {
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

  $note = $notes | Where-Object { $_.id -eq $id } | Select-Object -First 1
  if (-not $note) {
    Write-Host ""
    Write-Host "GET /notes response:"
    Write-Host $notesRaw
    throw "Note $id not found in GET /notes response. (DB likely not seeded or wrong DB configured.)"
  }

  return $note.lock
}

function Wait-Until-Unlocked([int]$id, [int]$timeoutSeconds) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($timeoutSeconds)
  $spinner = @("|","/","-","\")

  $i = 0
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $lock = GetNoteLockInfo $id

    if ($lock.isLocked -eq $false) {
      Done-Status "Note $id is unlocked"
      return
    }

    $expiresIso = Normalize-UtcIso $lock.expiresAt
    $expiresAt = [DateTimeOffset]::Parse($expiresIso)
    $remaining = ($expiresAt - [DateTimeOffset]::UtcNow).TotalSeconds
    $timeLeft = [Math]::Max(0, [int]([Math]::Ceiling($remaining)))

    $i = ($i + 1) % $spinner.Length
    Write-Status ("{0} Locked by {1} until {2} (remaining ~{3}s)" -f `
      $spinner[$i], `
      $lock.lockedBy, `
      $expiresAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ"), `
      $timeLeft)

    $sleepSeconds = 2
    if ($timeLeft -le 5) { $sleepSeconds = 1 }
    Start-Sleep -Seconds $sleepSeconds
  }

  Done-Status ""
  throw "Timed out waiting for note $id to become unlocked. Another session may be renewing the lock (e.g., open browser tab)."
}

function AcquireLock([string]$sessionId, [int]$id) {
  return Invoke-Curl @(
    "-i",
    "-X", "POST",
    "$baseUrl/notes/$id/lock",
    "-H", "x-session-id: $sessionId"
  )
}

function ReleaseLock([string]$sessionId, [int]$id) {
  return Invoke-Curl @(
    "-i",
    "-X", "DELETE",
    "$baseUrl/notes/$id/lock",
    "-H", "x-session-id: $sessionId"
  )
}

function PutJson([string]$sessionId, [int]$id, $payloadObject) {
  $json = ($payloadObject | ConvertTo-Json -Compress)
  $tempFile = New-TemporaryFile
  Set-Content -Path $tempFile -Value $json -Encoding UTF8

  try {
    return Invoke-Curl @(
      "-i",
      "-X", "PUT",
      "$baseUrl/notes/$id",
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

Write-Step "1) Ensure deterministic lock state"
$resetOk = Try-Reset-Locks
if (-not $resetOk) {
  Write-Host "Reset endpoint not available. Falling back to waiting for TTL expiry if needed."
  Write-Step "1b) Ensure note is unlocked (wait up to $maxWaitUnlockSeconds seconds if needed)"
  Wait-Until-Unlocked $noteId $maxWaitUnlockSeconds
}

Write-Step "2) Session A acquires lock (expect 200)"
$r = AcquireLock $sessionA $noteId
Assert-Status $r 200 "Session A acquire lock"

Write-Step "3) Session B tries to acquire lock (expect 423)"
$r = AcquireLock $sessionB $noteId
Assert-Status $r 423 "Session B acquire lock denied"

Write-Step "4) Session B tries to update (expect 423)"
$r = PutJson $sessionB $noteId @{ content = "B should not update" }
Assert-Status $r 423 "Session B update denied"

Write-Step "5) Session A updates (expect 200)"
$r = PutJson $sessionA $noteId @{ content = "Updated by A" }
Assert-Status $r 200 "Session A update"

Write-Step "6) Session A releases lock (expect 204)"
$r = ReleaseLock $sessionA $noteId
Assert-Status $r 204 "Session A release lock"

Write-Step "7) Session B can now acquire lock (expect 200)"
$r = AcquireLock $sessionB $noteId
Assert-Status $r 200 "Session B acquire after release"

Write-Host ""
Write-Host "Smoke test PASSED"