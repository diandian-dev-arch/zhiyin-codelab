[CmdletBinding()]
param([string]$NodeExecutable, [switch]$RunHost, [guid]$Instance = [guid]::NewGuid())

$ErrorActionPreference = 'Stop'
$trialRoot = Split-Path -Parent $PSScriptRoot
$trialDirectory = Join-Path $trialRoot '.data/teacher-trial'
$backgroundPath = Join-Path $trialDirectory "background-$Instance.json"
Set-Location -LiteralPath $trialRoot
if (!$NodeExecutable) {
    if ($env:CODELAB_NODE_EXECUTABLE) { $NodeExecutable = $env:CODELAB_NODE_EXECUTABLE }
    elseif (Test-Path -LiteralPath '.data/workspace-runtime.json') { $NodeExecutable = (Get-Content -Raw .data/workspace-runtime.json | ConvertFrom-Json).executable }
    else { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
}
if (![IO.Path]::IsPathRooted($NodeExecutable) -or $NodeExecutable.Contains('"')) { throw 'TEACHER_TRIAL_NODE_PATH_INVALID' }
$NodeExecutable = (Get-Item -LiteralPath $NodeExecutable -ErrorAction Stop).FullName
$env:CODELAB_NODE_EXECUTABLE = $NodeExecutable
New-Item -ItemType Directory -Path $trialDirectory -Force | Out-Null

if ($RunHost) {
    try {
        $launch = Start-Process -FilePath $NodeExecutable -ArgumentList @('--import','tsx','scripts/launch-workspace.ts','--teacher-trial') -WorkingDirectory $trialRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $trialDirectory "background-$Instance.stdout.log") -RedirectStandardError (Join-Path $trialDirectory "background-$Instance.stderr.log")
        $state = [ordered]@{instance=[string]$Instance;hostPid=$PID;launcherPid=$launch.Id;status='running';startedAt=[DateTime]::UtcNow.ToString('o')}
        $state | ConvertTo-Json | Set-Content -LiteralPath $backgroundPath -Encoding UTF8
        $launch.WaitForExit()
        $state.status='exited'; $state.exitCode=$launch.ExitCode; $state.finishedAt=[DateTime]::UtcNow.ToString('o')
        $state | ConvertTo-Json | Set-Content -LiteralPath $backgroundPath -Encoding UTF8
        exit $launch.ExitCode
    } catch {
        @{instance=[string]$Instance;hostPid=$PID;status='failed';code='TEACHER_TRIAL_BACKGROUND_FAILED'} | ConvertTo-Json | Set-Content -LiteralPath $backgroundPath -Encoding UTF8
        exit 1
    }
}

if (@(Get-NetTCPConnection -State Listen -LocalPort 5184,3184,3185 -ErrorAction SilentlyContinue).Count) { throw 'TEACHER_TRIAL_ALREADY_RUNNING_OR_PORT_OCCUPIED' }
& $NodeExecutable --import tsx scripts/launch-workspace.ts --teacher-trial --check
if ($LASTEXITCODE -ne 0) { throw 'TEACHER_TRIAL_RUNTIME_CHECK_FAILED' }
$powerShellExecutable=(Get-Command powershell.exe -ErrorAction Stop).Source
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
$command='"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -File "{1}" -RunHost -NodeExecutable "{2}" -Instance {3}' -f $powerShellExecutable,$PSCommandPath,$NodeExecutable,$Instance
$created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory=$trialRoot;ProcessStartupInformation=$startup}
if ($created.ReturnValue -ne 0) { throw 'TEACHER_TRIAL_BACKGROUND_CREATE_FAILED' }
$deadline=[DateTime]::UtcNow.AddSeconds(100)
do {
    try {
        if (Test-Path -LiteralPath $backgroundPath) {
            $background=Get-Content -Raw -LiteralPath $backgroundPath | ConvertFrom-Json
            if ($background.status -ne 'running') { throw 'TEACHER_TRIAL_BACKGROUND_EXITED' }
        }
        $statusPath=Join-Path $trialDirectory 'status.json'
        if (Test-Path -LiteralPath $statusPath) {
            $status=Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
            $control=Invoke-RestMethod -Uri 'http://127.0.0.1:3185/status' -TimeoutSec 2
            $health=Invoke-RestMethod -Uri 'http://127.0.0.1:3184/api/v1/health' -TimeoutSec 2
            $process=Get-CimInstance Win32_Process -Filter "ProcessId = $($status.pid)"
            $owners=@(Get-NetTCPConnection -State Listen -LocalPort 5184,3184,3185 -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
            $launcher=Get-CimInstance Win32_Process -Filter "ProcessId = $($background.launcherPid)"
            if ($status.phase -eq 'ready' -and $control.phase -eq 'ready' -and $control.environmentId -eq $status.environmentId -and
                $control.pid -eq $status.pid -and $owners.Count -eq 1 -and $owners[0] -eq $status.pid -and
                $process.CommandLine -match 'scripts[\\/]teacher-trial\.ts' -and $process.ParentProcessId -eq $background.launcherPid -and
                $background.hostPid -eq $created.ProcessId -and $launcher.ParentProcessId -eq $created.ProcessId -and
                $health.workspace -eq 'teacher-trial' -and !$health.modelsEnabled -and !$health.codeExecutionEnabled) {
                @{status='ready';workspace='teacher-trial';pid=$status.pid;lanUrl=$status.lanUrl;credentialsFile='.data/teacher-trial/private-credentials.json';firewallVerified=$false} | ConvertTo-Json -Compress
                exit 0
            }
        }
    } catch { if ($_.Exception.Message -eq 'TEACHER_TRIAL_BACKGROUND_EXITED') { throw } }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
@{status='readiness_unconfirmed';hostPid=$created.ProcessId;statePath=$backgroundPath} | ConvertTo-Json -Compress
throw 'TEACHER_TRIAL_MAY_STILL_BE_STARTING_CHECK_STATE_BEFORE_RETRY'
