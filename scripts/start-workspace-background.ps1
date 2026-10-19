[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)][int]$SchemaVersion = 0,
    [string]$NodeExecutable,
    [switch]$RunHost,
    [guid]$Instance = [guid]::NewGuid()
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $workspaceRoot '.data/business-v2'
$statePath = Join-Path $logDirectory "background-$Instance.json"
Set-Location -LiteralPath $workspaceRoot

if (!$NodeExecutable) {
    if ($env:CODELAB_NODE_EXECUTABLE) {
        $NodeExecutable = $env:CODELAB_NODE_EXECUTABLE
    } elseif (Test-Path -LiteralPath '.data/workspace-runtime.json') {
        $NodeExecutable = (Get-Content -LiteralPath '.data/workspace-runtime.json' -Raw | ConvertFrom-Json).executable
        if (!$NodeExecutable) { throw 'WORKSPACE_RUNTIME_CONFIG_INVALID' }
    } else {
        $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    }
}
if (![IO.Path]::IsPathRooted($NodeExecutable) -or $NodeExecutable.Contains('"')) {
    throw 'WORKSPACE_NODE_ABSOLUTE_PATH_REQUIRED'
}
$NodeExecutable = (Get-Item -LiteralPath $NodeExecutable -ErrorAction Stop).FullName
$env:CODELAB_NODE_EXECUTABLE = $NodeExecutable

if ($RunHost) {
    # This host belongs to Windows WMI, not the terminal/tool that requested it.
    # Keep the existing supervisor and its bounded child restart policy intact.
    try {
        if ($SchemaVersion -gt 0) { $env:CODELAB_WORKSPACE_SCHEMA_PIN = [string]$SchemaVersion }
        $launch = Start-Process -FilePath $NodeExecutable -ArgumentList @(
            '--import', 'tsx', 'scripts/launch-workspace.ts'
        ) -WorkingDirectory $workspaceRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDirectory "background-$Instance.stdout.log") `
            -RedirectStandardError (Join-Path $logDirectory "background-$Instance.stderr.log")
        $state = [ordered]@{
            instance = [string]$Instance
            hostPid = $PID
            launcherPid = $launch.Id
            startedAt = [DateTime]::UtcNow.ToString('o')
            schemaPin = $SchemaVersion
            status = 'running'
        }
        $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
        $launch.WaitForExit()
        $state.status = 'exited'
        $state.exitCode = $launch.ExitCode
        $state.finishedAt = [DateTime]::UtcNow.ToString('o')
        $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
        exit $launch.ExitCode
    } catch {
        @{ instance = [string]$Instance; hostPid = $PID; status = 'failed'; code = 'WORKSPACE_BACKGROUND_HOST_FAILED' } |
            ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
        exit 1
    }
}

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 5174,3102,3103 -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) { throw 'WORKSPACE_ALREADY_RUNNING_OR_PORT_OCCUPIED' }
& $NodeExecutable --import tsx scripts/launch-workspace.ts --check
if ($LASTEXITCODE -ne 0) { throw 'WORKSPACE_RUNTIME_CHECK_FAILED' }
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$powerShellExecutable = (Get-Command powershell.exe -ErrorAction Stop).Source
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
# All command arguments are fixed switches, validated paths, an integer and UUID.
# No credentials or inherited model settings are copied into the command line.
$command = '"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -File "{1}" -RunHost -NodeExecutable "{2}" -SchemaVersion {3} -Instance {4}' -f `
    $powerShellExecutable, $PSCommandPath, $NodeExecutable, $SchemaVersion, $Instance
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command
    CurrentDirectory = $workspaceRoot
    ProcessStartupInformation = $startup
}
if ($created.ReturnValue -ne 0) { throw "WORKSPACE_BACKGROUND_CREATE_FAILED_$($created.ReturnValue)" }

$deadline = [DateTime]::UtcNow.AddSeconds(75)
do {
    $state = $null
    if (Test-Path -LiteralPath $statePath) {
        # The host may be replacing its small status file at this exact moment.
        try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { }
    }
    if ($state) {
        if ($state.status -ne 'running') { throw 'WORKSPACE_BACKGROUND_START_FAILED_SEE_LOGS' }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5174/api/v1/health' -TimeoutSec 2
            $ports = @(Get-NetTCPConnection -State Listen -LocalPort 3102,3103,5174 -ErrorAction Stop)
            $guardOwners = @($ports | Where-Object LocalPort -eq 3103 | Select-Object -ExpandProperty OwningProcess -Unique)
            $webOwners = @($ports | Where-Object LocalPort -eq 5174 | Select-Object -ExpandProperty OwningProcess -Unique)
            $apiOwners = @($ports | Where-Object LocalPort -eq 3102 | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($guardOwners.Count -ne 1 -or $webOwners.Count -ne 1 -or $apiOwners.Count -ne 1) { throw 'WORKSPACE_PORTS_NOT_READY' }
            $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId = $($guardOwners[0])"
            $launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.launcherPid)"
            $workspace = Get-CimInstance Win32_Process -Filter "ProcessId = $($webOwners[0])"
            if ($health.ok -eq $true -and $health.businessVersion -eq 2 -and
                $state.hostPid -eq $created.ProcessId -and
                $launcher.ParentProcessId -eq $created.ProcessId -and
                $supervisor.ParentProcessId -eq $state.launcherPid -and
                $apiOwners[0] -eq $webOwners[0] -and
                $workspace.ParentProcessId -eq $supervisor.ProcessId) {
                @{ status = 'ready'; hostPid = $created.ProcessId; launcherPid = $state.launcherPid;
                    supervisorPid = $supervisor.ProcessId; workspacePid = $workspace.ProcessId; statePath = $statePath;
                    localUrl = 'http://127.0.0.1:5174/projects' } | ConvertTo-Json -Compress
                exit 0
            }
        } catch { }
    }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
Write-Output (@{ status = 'readiness_unconfirmed'; hostPid = $created.ProcessId; statePath = $statePath } | ConvertTo-Json -Compress)
throw 'WORKSPACE_BACKGROUND_MAY_STILL_BE_STARTING_CHECK_STATE_BEFORE_RETRY'
