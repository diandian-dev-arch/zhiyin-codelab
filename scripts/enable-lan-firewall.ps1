$ErrorActionPreference = 'Stop'
$ruleName = 'CodeLab-Team-LAN-5174'
$address = '10.38.31.238'
$interface = (Get-NetIPAddress -IPAddress $address -AddressFamily IPv4).InterfaceAlias
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($existing) { Remove-NetFirewallRule -Name $ruleName }
New-NetFirewallRule -Name $ruleName -DisplayName 'CodeLab team demo TCP 5174' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5174 -LocalAddress $address -RemoteAddress '10.0.0.0/8' -InterfaceAlias $interface -Profile Any | Out-Null
Write-Host 'CodeLab LAN firewall rule enabled.'
