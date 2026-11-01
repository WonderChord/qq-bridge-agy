param(
  [switch]$ForceRestartNapCat
)

# 守护脚本：确保无头 NapCat（:3000 / WebUI :6099）与 qq-bridge（:3100）在线，全部无窗口启动。
# 路径与账号全部来自 config.json → napcat：
#   napcat.dir           NapCat Shell 目录（含 NapCatWinBootMain.exe）
#   napcat.account       机器人 QQ 号
#   napcat.dataDir       可选，NAPCAT_DATA_DIR（让机器人号与个人 QQ 数据隔离）
#   napcat.userDataDir   可选，NAPCAT_USER_DATA_DIR
#   napcat.onebotConfig  可选，onebot11_<QQ>.json 路径（读取 HTTP token；缺省用 snowluma.accessToken）
#   napcat.nodeExe       可选，node.exe 路径（缺省用 PATH 里的 node）

$ErrorActionPreference = 'Stop'
$BridgeDir = Split-Path -Parent $PSScriptRoot
$BridgeCfg = Get-Content (Join-Path $BridgeDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$NapCfg = $BridgeCfg.napcat
$NodeExe = if ($NapCfg.nodeExe) { [string]$NapCfg.nodeExe } else { (Get-Command node -ErrorAction Stop).Source }
$NapCatDir = [string]$NapCfg.dir
$BotQQ = [string]$NapCfg.account
if (-not $NapCatDir -or -not $BotQQ) { throw 'config.json 缺少 napcat.dir / napcat.account' }

function Test-LocalPort([int]$Port) {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1200, $false)
    if ($ok -and $tcp.Connected) {
      $tcp.Close()
      return $true
    }
    $tcp.Close()
    return $false
  } catch {
    return $false
  }
}

# NTQQ 内核真实活性探针：带 no_cache 的 get_stranger_info 才能抓出 MSF 断流假死
function Test-NapCatKernelAlive {
  if (-not (Test-LocalPort 3000)) { return $false }
  try {
    $token = [string]$BridgeCfg.snowluma.accessToken
    $onebotCfg = [string]$NapCfg.onebotConfig
    if ($onebotCfg -and (Test-Path $onebotCfg)) {
      $ob = Get-Content $onebotCfg -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($ob.network.httpServers[0].token) { $token = $ob.network.httpServers[0].token }
    }
    $body = '{"user_id":' + $BotQQ + ',"no_cache":true}'
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      try {
        $res = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/get_stranger_info' `
          -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } `
          -Body $body -TimeoutSec 8
        if ($res.status -eq 'ok' -and $res.retcode -eq 0) {
          return $true
        }
      } catch {}
      if ($attempt -lt 2) { Start-Sleep -Seconds 3 }
    }
    return $false
  } catch {
    return $false
  }
}

function Get-HeadlessNapCat {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'NapCatWinBootMain.exe' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($NapCatDir, [StringComparison]::OrdinalIgnoreCase))
  }
}

function Stop-HeadlessNapCatOnly {
  $procs = Get-HeadlessNapCat
  if ($procs) {
    Write-Host "[ensure-daemons] Stopping headless NapCat processes ($($procs.ProcessId -join ','))..."
    foreach ($p in $procs) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
  }
}

$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly

# 1. Ensure Headless NapCat（机器人号独立数据目录，与个人 QQ 互不影响）
$napProc = Get-HeadlessNapCat
$portsAlive = (Test-LocalPort 3000) -or (Test-LocalPort 6099)

if (-not $ForceRestartNapCat -and $napProc -and (Test-LocalPort 3000)) {
  if (-not (Test-NapCatKernelAlive)) {
    Write-Host '[ensure-daemons] WARNING: NapCat port 3000 is open but NTQQ kernel probe (get_stranger_info no_cache) timed out! Triggering ForceRestartNapCat...'
    $ForceRestartNapCat = $true
  }
}

if ($ForceRestartNapCat -or (-not $portsAlive)) {
  if ($napProc) {
    Stop-HeadlessNapCatOnly
  }
  Write-Host "[ensure-daemons] Starting headless NapCat ($BotQQ) via WMI (ShowWindow=0, NO_PROXY=*)..."
  $envParts = @('set NO_PROXY=*', 'set HTTP_PROXY=', 'set HTTPS_PROXY=', "set NAPCAT_QUICK_ACCOUNT=$BotQQ")
  if ($NapCfg.dataDir) { $envParts += "set NAPCAT_DATA_DIR=$($NapCfg.dataDir)" }
  if ($NapCfg.userDataDir) { $envParts += "set NAPCAT_USER_DATA_DIR=$($NapCfg.userDataDir)" }
  $exe = Join-Path $NapCatDir 'NapCatWinBootMain.exe'
  $napCmd = 'cmd.exe /c "' + ($envParts -join '&& ') + '&& "' + $exe + '" ' + $BotQQ + '"'
  $r1 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $napCmd
    CurrentDirectory = $NapCatDir
    ProcessStartupInformation = $si
  }
  Write-Host "[ensure-daemons] NapCat WMI launch ReturnValue=$($r1.ReturnValue) PID=$($r1.ProcessId)"
  for ($i = 0; $i -lt 28; $i++) {
    Start-Sleep -Seconds 1
    if (Test-LocalPort 3000) { break }
  }
  if (-not (Test-LocalPort 3000) -and (Test-LocalPort 6099)) {
    & $NodeExe "$BridgeDir\scripts\napcat-auto-relogin.mjs" | Out-Host
  }
} else {
  Write-Host '[ensure-daemons] NapCat already running and kernel probe healthy.'
  if ((Test-LocalPort 6099) -and -not (Test-LocalPort 3000)) {
    & $NodeExe "$BridgeDir\scripts\napcat-auto-relogin.mjs" | Out-Host
  }
}

# 2. Ensure qq-bridge (127.0.0.1:3100)
if (-not (Test-LocalPort 3100)) {
  Write-Host '[ensure-daemons] Starting hidden qq-bridge (src/bridge.js) via WMI (ShowWindow=0)...'
  $bridgeCmd = "`"$NodeExe`" `"$BridgeDir\src\bridge.js`""
  $r2 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $bridgeCmd
    CurrentDirectory = $BridgeDir
    ProcessStartupInformation = $si
  }
  Write-Host "[ensure-daemons] bridge.js WMI launch ReturnValue=$($r2.ReturnValue) PID=$($r2.ProcessId)"
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 600
    if (Test-LocalPort 3100) { break }
  }
} else {
  Write-Host '[ensure-daemons] qq-bridge (:3100) already running.'
}
