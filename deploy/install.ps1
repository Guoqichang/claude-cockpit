# 一键装 Claude Cockpit（Windows 原生 PowerShell）
# 用法：
#   irm https://raw.githubusercontent.com/Guoqichang/claude-cockpit/master/deploy/install.ps1 | iex
# 或在已克隆的仓库里：
#   powershell -ExecutionPolicy Bypass -File deploy\install.ps1
#
# 已经在用 WSL 的人：进 Ubuntu 后跑 bash deploy/install.sh，不要用本脚本。

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/Guoqichang/claude-cockpit.git'
$OpenUrl = 'http://127.0.0.1:7799/#setup'

function Say([string]$m) { Write-Host $m }

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machine, $user, $env:Path) -join ';'
  $env:Path = "$env:USERPROFILE\.opencode\bin;$env:USERPROFILE\.local\bin;$env:Path"
}

function Ensure-Cmd([string]$name) {
  Refresh-Path
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Ensure-Node {
  if (Ensure-Cmd 'node') {
    $major = [int]((node -p "process.versions.node.split('.')[0]"))
    if ($major -ge 18) { return (Get-Command node).Source }
    throw "Node.js 版本是 $(node -v)，需要 18+。请升级后重开 PowerShell。"
  }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "找不到 Node.js。请先从 https://nodejs.org/ 安装 LTS，勾选 Add to PATH，然后重开 PowerShell。"
  }
  Say '正在用 winget 安装 Node.js LTS…'
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Ensure-Cmd 'node')) {
    throw 'Node 装完还不在 PATH。关掉这个窗口，新开一个 PowerShell，再跑一次本脚本。'
  }
  return (Get-Command node).Source
}

function Get-Root {
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\server.js'))) {
    return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  }
  $dest = Join-Path $env:USERPROFILE 'claude-cockpit'
  if (-not (Test-Path (Join-Path $dest 'server.js'))) {
    if (-not (Ensure-Cmd 'git')) {
      if (Get-Command winget -ErrorAction SilentlyContinue) {
        Say '正在用 winget 安装 Git…'
        winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
        Refresh-Path
      }
    }
    if (-not (Ensure-Cmd 'git')) {
      throw '需要 Git。请先装 https://git-scm.com/ 并重开 PowerShell。'
    }
    Say "正在克隆 $RepoUrl → $dest"
    git clone $RepoUrl $dest
  }
  return $dest
}

Say '=== Claude Cockpit 一键安装（Windows）==='
Say '路线：装 Node → 拉仓库 → npm install → 装 OpenCode → 登录时自启 → 打开向导填 Key'
Say ''

$node = Ensure-Node
$root = Get-Root
Say "仓库：$root"
Say "node：$node"

Set-Location $root
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Say '正在 npm install…（第一次编 node-pty 可能要一两分钟）'
  npm install
} else {
  Say 'node_modules 已在，跳过 npm install'
}

Refresh-Path
$oc = Join-Path $env:USERPROFILE '.opencode\bin\opencode.exe'
if (-not (Ensure-Cmd 'opencode') -and -not (Test-Path $oc)) {
  Say '正在安装 OpenCode（官方脚本）…'
  irm https://opencode.ai/install | iex
  Refresh-Path
} else {
  Say 'OpenCode 已安装'
}

if (-not (Ensure-Cmd 'python') -and -not (Ensure-Cmd 'py') -and -not (Ensure-Cmd 'python3')) {
  Say '没检测到 Python 3。先聊不受影响；想导入已有 OpenCode 会话可稍后： winget install Python.Python.3.12'
}

$startCmd = Join-Path $root 'deploy\start.cmd'
if (-not (Test-Path $startCmd)) { throw "缺少 $startCmd" }

$taskName = 'ClaudeCockpit'
Say "登记计划任务 $taskName（登录时启动、崩溃重试）…"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$startCmd`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
} catch {
  Say "计划任务登记失败：$($_.Exception.Message)"
  Say "仍可双击 deploy\start.cmd 手动启动。"
}

try {
  $listening = Get-NetTCPConnection -LocalPort 7799 -State Listen -ErrorAction SilentlyContinue
} catch {
  $listening = $null
}
if (-not $listening) {
  Say '正在启动 Cockpit…'
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 2
} else {
  Say '7799 已经在听，不再重复拉起'
}

Say ''
Say "打开浏览器：$OpenUrl"
Say '在向导里贴一把 DeepSeek API Key，再点「开一条 OpenCode」。'
Say '停用自启：Unregister-ScheduledTask -TaskName ClaudeCockpit -Confirm:$false'
try { Start-Process $OpenUrl } catch { }
