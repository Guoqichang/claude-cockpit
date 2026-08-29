# pcy-02 unattended network + remote access healer. Runs as SYSTEM every 2 min.
$ErrorActionPreference = 'SilentlyContinue'
$Root = 'C:\ProgramData\pcy02'
$Log  = Join-Path $Root 'watchdog.log'
New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $Log -Value $line -Encoding UTF8
  if ((Get-Item $Log).Length -gt 512KB) {
    Move-Item $Log ($Log + '.old') -Force
  }
}

function Ensure-Service([string]$name) {
  $s = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $s) { return $false }
  if ($s.StartType -ne 'Automatic') { Set-Service $name -StartupType Automatic }
  if ($s.Status -ne 'Running') { Start-Service $name; Log "started $name" }
  return $true
}

function Has-DefaultRoute {
  $r = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Where-Object { $_.NextHop -ne '0.0.0.0' -and $_.NextHop -notlike '100.*' }
  return [bool]$r
}

function Wifi-Adapter {
  Get-NetAdapter | Where-Object {
    $_.Status -ne 'Disabled' -and ($_.Name -match 'Wi-Fi|WLAN|无线')
  } | Select-Object -First 1
}

# --- power: never sleep on AC, including HDMI unplug ---
$ns = Join-Path $Root 'never-sleep.ps1'
if (Test-Path $ns) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ns }
else {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /hibernate off | Out-Null
}

# --- clash TUN kills campus DNS + Tailscale; do not let it own the box ---
$tun = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Clash|Meta|Wintun|WireGuard' -and $_.Name -notmatch 'Tailscale' }
if ($tun) {
  Get-Process | Where-Object { $_.Name -match 'Clash|clash-win|Clash for Windows' } | Stop-Process -Force
  Log 'stopped Clash (TUN present)'
}

# --- NIC power saving off ---
Get-NetAdapter | Where-Object { $_.HardwareInterface } | ForEach-Object {
  try { Set-NetAdapterPowerManagement -Name $_.Name -ArpOffload Disabled -NSOffload Disabled -SelectiveSuspend Disabled -ErrorAction SilentlyContinue } catch {}
}

# --- services ---
Ensure-Service 'WlanSvc' | Out-Null
Ensure-Service 'Tailscale' | Out-Null
Ensure-Service 'sshd' | Out-Null

# --- only uplink is HKUSTGZ; never wait on ethernet ---
$wlan = Wifi-Adapter
if ($wlan -and $wlan.Status -ne 'Up') { Enable-NetAdapter -Name $wlan.Name -Confirm:$false }

if (-not (Has-DefaultRoute)) {
  Ensure-Service 'WlanSvc' | Out-Null
  netsh wlan disconnect | Out-Null
  Start-Sleep -Seconds 2
  netsh wlan connect name=HKUSTGZ ssid=HKUSTGZ | Out-Null
  Log 'wlan connect HKUSTGZ'
  Start-Sleep -Seconds 10
}

# --- sshd must listen ---
$sshd = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
if (-not $sshd) {
  Restart-Service sshd -Force
  Log 'restarted sshd (22 not listening)'
}

# --- tailscale should be connected ---
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) {
  $cands = @(
    "$env:ProgramFiles\Tailscale\tailscale.exe",
    "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe"
  )
  foreach ($c in $cands) { if (Test-Path $c) { $ts = $c; break } }
} else { $ts = $ts.Source }
if ($ts) {
  $st = & $ts status --json 2>$null | ConvertFrom-Json
  if ($st -and $st.BackendState -ne 'Running') {
    & $ts up --unattended 2>$null | Out-Null
    Log ('tailscale up, state was ' + $st.BackendState)
  }
}

# --- RDP listener ---
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue

# --- WSL / Cockpit: NEVER call wsl.exe from SYSTEM (kills systemd dbus). ---
# keep-wsl.ps1 in the auto-logon session owns the distro + portproxy.
$hb = Join-Path $Root 'wsl-heartbeat.txt'
$hbAge = 99999
if (Test-Path $hb) {
  try { $hbAge = [int]([DateTimeOffset]::Now.ToUnixTimeSeconds() - [int64]((Get-Content $hb -Raw).Trim())) } catch { $hbAge = 99999 }
}
if ($hbAge -gt 90) {
  schtasks.exe /Run /TN pcy02-wsl 2>$null | Out-Null
  Log "keep-wsl heartbeat stale age=$hbAge, started task"
}
$ipFile = Join-Path $Root 'wsl-ip.txt'
if (Test-Path $ipFile) {
  $wslIp = (Get-Content $ipFile -Raw).Trim()
  if ($wslIp -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') {
    netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=7799 2>$null | Out-Null
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=7799 connectaddress=$wslIp connectport=7799 | Out-Null
  }
}
if (-not (Get-NetFirewallRule -DisplayName 'Cockpit 7799' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Cockpit 7799' -Direction Inbound -Protocol TCP -LocalPort 7799 -Action Allow -Profile Any | Out-Null
}
