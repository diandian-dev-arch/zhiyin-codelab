[CmdletBinding()]
param([Parameter(Mandatory=$true)][uri]$BaseUrl)
$ErrorActionPreference='Stop'
if ($BaseUrl.Scheme -ne 'http' -or $BaseUrl.Port -ne 5184 -or $BaseUrl.UserInfo -or $BaseUrl.Query -or $BaseUrl.Fragment -or $BaseUrl.AbsolutePath -ne '/' -or $BaseUrl.Host -notmatch '^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$') {
    throw 'TRIAL_CAMPUS_URL_REQUIRED: Use the supplied http://10.x.x.x:5184/ address without credentials or extra parameters.'
}
$address=[Net.IPAddress]::Parse($BaseUrl.Host)
if ($address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'INVALID_TRIAL_ADDRESS' }
$sameMachine=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object IPAddress -EQ $BaseUrl.Host).Count -gt 0
try {
    $health=Invoke-RestMethod -Uri ([uri]::new($BaseUrl,'api/v1/health')) -TimeoutSec 10
    if ($health.workspace -ne 'teacher-trial' -or $health.executionApproved -or $health.modelsEnabled -or $health.codeExecutionEnabled) { throw 'IDENTITY_OR_SCOPE_MISMATCH' }
    $page=Invoke-WebRequest -UseBasicParsing -Uri ([uri]::new($BaseUrl,'assignments')) -TimeoutSec 10
    if ($page.StatusCode -ne 200) { throw 'PAGE_NOT_READY' }
    @{status='reachable';workspace='teacher-trial';pageHTTP=200;runOnServerComputer=$sameMachine;
      secondComputerNetworkProbe=(!$sameMachine);loginAndTeacherFlowVerified=$false;modelsEnabled=$false;codeExecutionEnabled=$false} | ConvertTo-Json -Compress
} catch {
    @{status='unverified';runOnServerComputer=$sameMachine;help='Check campus reachability, scoped 5184 firewall rule and trial service. Do not disable the firewall.'} | ConvertTo-Json -Compress
    exit 1
}
