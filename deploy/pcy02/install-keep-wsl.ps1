# Register unlimited ONLOGON keep-wsl task and start it now.
$ErrorActionPreference = 'Continue'
$Root = 'C:\ProgramData\pcy02'
$wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
$cfg = @"
[wsl2]
memory=8GB
processors=6
swap=4GB
localhostForwarding=true
vmIdleTimeout=86400000
"@
Set-Content -Path $wslconfig -Value $cfg.Trim() -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\ProgramData\pcy02\keep-wsl.ps1'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'Administrator'
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'pcy02-wsl' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output 'TASK_REGISTERED'
Start-ScheduledTask -TaskName 'pcy02-wsl'
Write-Output 'TASK_STARTED'
