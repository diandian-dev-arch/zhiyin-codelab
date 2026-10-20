[CmdletBinding(SupportsShouldProcess=$true)]
param()
$ErrorActionPreference='Stop'
if (!$WhatIfPreference -and !([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_POWERSHELL_REQUIRED: Original port 5174 rule will not be changed.'
}
$trialRoot=Split-Path -Parent $PSScriptRoot
$lan=Get-Content -Raw -LiteralPath (Join-Path $trialRoot '.data/workspace-lan.json') | ConvertFrom-Json
$status=Get-Content -Raw -LiteralPath (Join-Path $trialRoot '.data/teacher-trial/status.json') | ConvertFrom-Json
$address=[Net.IPAddress]::Parse($lan.address)
if (!$lan.enabled -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $address.GetAddressBytes()[0] -ne 10 -or
    $status.workspace -ne 'teacher-trial' -or ([uri]$status.lanUrl).Host -ne $lan.address) { throw 'TEACHER_TRIAL_CAMPUS_SCOPE_UNCONFIRMED_NO_RULE_CHANGED' }
$interfaces=@(Get-NetIPAddress -IPAddress $lan.address -AddressFamily IPv4 -ErrorAction Stop | Select-Object -ExpandProperty InterfaceAlias -Unique)
if ($interfaces.Count -ne 1) { throw 'TEACHER_TRIAL_INTERFACE_UNCONFIRMED' }
$name='CodeLab-Teacher-Trial-5184'
$description="CodeLab isolated teacher trial $($status.environmentId)"
$existing=Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($existing) {
    $ports=$existing | Get-NetFirewallPortFilter
    $addresses=$existing | Get-NetFirewallAddressFilter
    $interface=$existing | Get-NetFirewallInterfaceFilter
    if ($existing.Description -ne $description -or $existing.Enabled -ne 'True' -or $existing.Direction -ne 'Inbound' -or $existing.Action -ne 'Allow' -or
        $ports.Protocol -ne 'TCP' -or $ports.LocalPort -ne '5184' -or @($addresses.LocalAddress).Count -ne 1 -or @($addresses.LocalAddress) -notcontains $lan.address -or
        @($addresses.RemoteAddress).Count -ne 1 -or $addresses.RemoteAddress -notin @('10.0.0.0/8','10.0.0.0/255.0.0.0') -or
        @($interface.InterfaceAlias).Count -ne 1 -or $interface.InterfaceAlias -ne $interfaces[0]) { throw 'TEACHER_TRIAL_RULE_MISMATCH_NO_RULE_CHANGED' }
} else {
    if ($PSCmdlet.ShouldProcess("$($lan.address):5184 on $($interfaces[0]) from 10.0.0.0/8", 'Create dedicated teacher-trial firewall rule')) {
        New-NetFirewallRule -Name $name -DisplayName 'CodeLab isolated teacher trial TCP 5184' -Description $description -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5184 `
            -LocalAddress $lan.address -RemoteAddress '10.0.0.0/8' -InterfaceAlias $interfaces[0] -Profile Any | Out-Null
    }
}
@{status=$(if ($WhatIfPreference) {'scope_preflight_only'} else {'scoped_rule_ready'});rule=$name;port=5184;remoteScope='10.0.0.0/8';originalRule5174Changed=$false;secondComputerVerified=$false} | ConvertTo-Json -Compress
