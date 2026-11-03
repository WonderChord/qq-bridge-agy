param(
  [switch]$ForceRestartNapCat,
  [switch]$ForceRestartBridge
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
if (-not $NapCatDir -or $BotQQ -notmatch '^[1-9]\d*$') { throw '请检查 napcat.dir 和 napcat.account' }
if (-not [IO.Path]::IsPathRooted($NapCatDir)) { $NapCatDir = Join-Path $BridgeDir $NapCatDir }
$exe = (Get-Item -LiteralPath (Join-Path $NapCatDir 'NapCatWinBootMain.exe') -ErrorAction Stop).FullName
$NapCatDir = Split-Path -Parent $exe
$napPrefix = $NapCatDir.TrimEnd('\') + '\'
if ($napPrefix -eq [IO.Path]::GetPathRoot($exe)) { throw '请将 napcat.dir 指向独立安装目录' }
$consolePort = if ($BridgeCfg.consolePort) { [int]$BridgeCfg.consolePort } else { 3100 }
$httpUrl = if ($BridgeCfg.snowluma.httpUrl) { [uri]$BridgeCfg.snowluma.httpUrl } else { [uri]'http://127.0.0.1:3000' }
if (-not $httpUrl.IsLoopback -or $httpUrl.Scheme -ne 'http') { throw '无头守护需要本机 OneBot HTTP 地址' }
$httpPort = $httpUrl.Port
$webuiPort = 6099
if ($NapCfg.webuiConfigPath) {
  $webuiFile = [string]$NapCfg.webuiConfigPath
  if (-not [IO.Path]::IsPathRooted($webuiFile)) { $webuiFile = Join-Path $BridgeDir $webuiFile }
  $webui = Get-Content -LiteralPath $webuiFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($webui.port) { $webuiPort = [int]$webui.port }
}

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
  if (-not (Test-LocalPort $httpPort)) { return $false }
  try {
    $token = [string]$BridgeCfg.snowluma.accessToken
    $onebotCfg = [string]$NapCfg.onebotConfig
    if ($onebotCfg) {
      if (-not [IO.Path]::IsPathRooted($onebotCfg)) { $onebotCfg = Join-Path $BridgeDir $onebotCfg }
      $ob = Get-Content -LiteralPath $onebotCfg -Raw -Encoding UTF8 | ConvertFrom-Json
      $listener = $ob.network.httpServers | Where-Object { $_.port -eq $httpPort } | Select-Object -First 1
      if ($listener) { $token = [string]$listener.token }
    }
    $body = '{"user_id":' + $BotQQ + ',"no_cache":true}'
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      try {
        $res = Invoke-RestMethod -Method Post -Uri ([uri]::new($httpUrl, '/get_stranger_info')) -MaximumRedirection 0 `
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
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($napPrefix, [StringComparison]::OrdinalIgnoreCase)
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
$portsAlive = (Test-LocalPort $httpPort) -or (Test-LocalPort $webuiPort)

if (-not $ForceRestartNapCat -and $napProc -and (Test-LocalPort $httpPort)) {
  if (-not (Test-NapCatKernelAlive)) {
    Write-Host '[ensure-daemons] WARNING: NapCat HTTP port is open but NTQQ kernel probe (get_stranger_info no_cache) timed out! Triggering ForceRestartNapCat...'
    $ForceRestartNapCat = $true
  }
}

if ($ForceRestartNapCat -or (-not $portsAlive)) {
  if ($napProc) {
    Stop-HeadlessNapCatOnly
  }
  Write-Host "[ensure-daemons] Starting headless NapCat ($BotQQ) via WMI (ShowWindow=0, NO_PROXY=*)..."
  $napEnv = [Environment]::GetEnvironmentVariables()
  $napEnv['NO_PROXY'] = '*'
  $napEnv.Remove('HTTP_PROXY')
  $napEnv.Remove('HTTPS_PROXY')
  $napEnv['NAPCAT_QUICK_ACCOUNT'] = $BotQQ
  if ($NapCfg.dataDir) { $napEnv['NAPCAT_DATA_DIR'] = [string]$NapCfg.dataDir }
  if ($NapCfg.userDataDir) { $napEnv['NAPCAT_USER_DATA_DIR'] = [string]$NapCfg.userDataDir }
  $napStart = New-CimInstance -ClassName Win32_ProcessStartup -Property @{
    ShowWindow = [uint16]0
    EnvironmentVariables = [string[]]@($napEnv.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
  } -ClientOnly
  $napCmd = '"{0}" {1}' -f $exe, $BotQQ
  $r1 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $napCmd
    CurrentDirectory = $NapCatDir
    ProcessStartupInformation = $napStart
  }
  if ($r1.ReturnValue -ne 0) { throw "NapCat 启动失败，WMI 返回 $($r1.ReturnValue)" }
  Write-Host "[ensure-daemons] NapCat WMI launch ReturnValue=$($r1.ReturnValue) PID=$($r1.ProcessId)"
  for ($i = 0; $i -lt 28; $i++) {
    Start-Sleep -Seconds 1
    if (Test-LocalPort $httpPort) { break }
  }
  if (-not (Test-LocalPort $httpPort) -and (Test-LocalPort $webuiPort)) {
    & $NodeExe "$BridgeDir\scripts\napcat-auto-relogin.mjs" | Out-Host
  }
} else {
  Write-Host '[ensure-daemons] NapCat already running and kernel probe healthy.'
  if ((Test-LocalPort $webuiPort) -and -not (Test-LocalPort $httpPort)) {
    & $NodeExe "$BridgeDir\scripts\napcat-auto-relogin.mjs" | Out-Host
  }
}

# 2. Ensure qq-bridge (127.0.0.1:3100)
if ($ForceRestartBridge -and (Test-LocalPort $consolePort)) {
  Write-Host '[ensure-daemons] ForceRestartBridge: stopping existing qq-bridge...'
  & $NodeExe "$BridgeDir\scripts\manage-bridge.mjs" stop | Out-Host
  Start-Sleep -Milliseconds 500
}
if (-not (Test-LocalPort $consolePort)) {
  Write-Host '[ensure-daemons] Starting hidden qq-bridge (src/bridge.js) via WMI (ShowWindow=0)...'
  $bridgeCmd = "`"$NodeExe`" `"$BridgeDir\src\bridge.js`""
  $r2 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $bridgeCmd
    CurrentDirectory = $BridgeDir
    ProcessStartupInformation = $si
  }
  if ($r2.ReturnValue -ne 0) { throw "桥接启动失败，WMI 返回 $($r2.ReturnValue)" }
  Write-Host "[ensure-daemons] bridge.js WMI launch ReturnValue=$($r2.ReturnValue) PID=$($r2.ProcessId)"
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 600
    if (Test-LocalPort $consolePort) { break }
  }
  if (-not (Test-LocalPort $consolePort)) { throw "桥接端口 $consolePort 启动超时，请查看 state/bridge.log" }
} else {
  Write-Host "[ensure-daemons] qq-bridge (:$consolePort) already running."
}
