$ErrorActionPreference='Stop'
$trialRoot=Split-Path -Parent $PSScriptRoot
$trialDirectory=Join-Path $trialRoot '.data/teacher-trial'
$status=Get-Content -Raw -LiteralPath (Join-Path $trialDirectory 'status.json') | ConvertFrom-Json
$secrets=Get-Content -Raw -LiteralPath (Join-Path $trialDirectory 'private-credentials.json') | ConvertFrom-Json
$control=Invoke-RestMethod -Uri 'http://127.0.0.1:3185/status' -TimeoutSec 3
if ($control.workspace -ne 'teacher-trial' -or $control.environmentId -ne $status.environmentId -or $control.environmentId -ne $secrets.environmentId -or $control.pid -ne $status.pid) { throw 'TEACHER_TRIAL_IDENTITY_CHANGED' }
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3185/shutdown' -Headers @{Authorization="Bearer $($secrets.controlToken)"} -TimeoutSec 5 | Out-Null
$deadline=[DateTime]::UtcNow.AddSeconds(25)
do {
    $current=Get-Content -Raw -LiteralPath (Join-Path $trialDirectory 'status.json') | ConvertFrom-Json
    if ($current.environmentId -eq $status.environmentId -and $current.phase -eq 'stopped' -and
        !@(Get-NetTCPConnection -State Listen -LocalPort 5184,3184,3185 -ErrorAction SilentlyContinue).Count) {
        @{status='stopped';databaseAndResultsPreserved=$true;originalWorkspaceChanged=$false} | ConvertTo-Json -Compress
        exit 0
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
throw 'TEACHER_TRIAL_SHUTDOWN_UNCONFIRMED'
