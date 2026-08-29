# Keep WSL2 Ubuntu + Claude Cockpit alive in the auto-logon user session.
# Must NOT run as SYSTEM. SYSTEM wsl.exe breaks systemd dbus.
$ErrorActionPreference = 'Continue'
$Root = 'C:\ProgramData\pcy02'
$Log  = Join-Path $Root 'keep-wsl.log'
$Wsl  = 'C:\Program Files\WSL\wsl.exe'
$Loop = '/mnt/c/ProgramData/pcy02/cockpit-loop.sh'
$Hb   = Join-Path $Root 'wsl-heartbeat.txt'
$IpF  = Join-Path $Root 'wsl-ip.txt'
$Need = Join-Path $Root 'wsl-need-restart.txt'
New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $Log -Value $line -Encoding UTF8
  if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 256KB) {
    Move-Item $Log ($Log + '.old') -Force
  }
}

function HeartbeatAge {
  if (-not (Test-Path $Hb)) { return 99999 }
  try {
    $raw = (Get-Content -Path $Hb -Raw -ErrorAction Stop).Trim()
    $t = [int64]$raw
    return [int]([DateTimeOffset]::Now.ToUnixTimeSeconds() - $t)
  } catch { return 99999 }
}

function Set-Portproxy([string]$ip) {
  if ($ip -notmatch '^172\.(1[6-9]|2[0-9]|3[0-1])\.') { return }
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=7799 2>$null | Out-Null
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=7799 connectaddress=$ip connectport=7799 | Out-Null
  Log "portproxy 0.0.0.0:7799 -> ${ip}:7799"
}

function Ensure-Firewall {
  if (-not (Get-NetFirewallRule -DisplayName 'Cockpit 7799' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Cockpit 7799' -Direction Inbound -Protocol TCP -LocalPort 7799 -Action Allow -Profile Any | Out-Null
    Log 'firewall Cockpit 7799'
  }
}

$lastSpawn = [datetime]::MinValue
function Spawn-Loop {
  if (((Get-Date) - $lastSpawn).TotalSeconds -lt 25) { return }
  $script:lastSpawn = Get-Date
  if (-not (Test-Path $Wsl)) { Log 'ERROR missing wsl.exe'; return }
  Start-Process -FilePath $Wsl -ArgumentList @('-d','Ubuntu-24.04','--','bash',$Loop) -WindowStyle Hidden | Out-Null
  Log 'spawned cockpit-loop'
}

Log 'keep-wsl start'
$lastIp = ''
Ensure-Firewall
Spawn-Loop

while ($true) {
  try {
    $age = HeartbeatAge
    if (Test-Path $Need) {
      Log 'need-restart flag, terminate distro'
      & $Wsl --terminate Ubuntu-24.04 2>$null | Out-Null
      Remove-Item $Need -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
      Spawn-Loop
    } elseif ($age -gt 90 -and ((Get-Date) - $lastSpawn).TotalSeconds -ge 60) {
      Log "heartbeat stale age=$age"
      Spawn-Loop
      Start-Sleep -Seconds 20
      if ((HeartbeatAge) -gt 90) {
        Log 'still stale, terminate distro'
        & $Wsl --terminate Ubuntu-24.04 2>$null | Out-Null
        Start-Sleep -Seconds 5
        Spawn-Loop
      }
    }

    if (Test-Path $IpF) {
      $ip = (Get-Content -Path $IpF -Raw -ErrorAction SilentlyContinue).Trim()
      if ($ip -and $ip -ne $lastIp) {
        Set-Portproxy $ip
        $lastIp = $ip
      }
    }
    Ensure-Firewall
  } catch {
    Log ("keep-wsl error " + $_.Exception.Message)
  }
  Start-Sleep -Seconds 15
}
