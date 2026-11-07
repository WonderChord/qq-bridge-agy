param(
  [switch]$ForceRestartNapCat,
  [switch]$ForceRestartBridge
)

# Daemon guardian: ensure headless NapCat (:3000 / WebUI :6099) and qq-bridge (:3100) stay online (ShowWindow=0).
# Paths and account come from config.json -> napcat:
#   napcat.dir           NapCat Shell directory (containing NapCatWinBootMain.exe)
#   napcat.account       Bot QQ uin
#   napcat.dataDir       Optional, NAPCAT_DATA_DIR (isolated from personal QQ)
#   napcat.userDataDir   Optional, NAPCAT_USER_DATA_DIR
#   napcat.onebotConfig  Optional, onebot11_<QQ>.json path (fallback: snowluma.accessToken)
#   napcat.nodeExe       Optional, node.exe path (fallback: node in PATH)

$ErrorActionPreference = 'Stop'
$BridgeDir = Split-Path -Parent $PSScriptRoot
$BridgeCfg = Get-Content (Join-Path $BridgeDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$NapCfg = $BridgeCfg.napcat
$NodeExe = if ($NapCfg.nodeExe) { [string]$NapCfg.nodeExe } else { (Get-Command node -ErrorAction Stop).Source }
$NapCatDir = [string]$NapCfg.dir
$BotQQ = [string]$NapCfg.account
if (-not $NapCatDir -or $BotQQ -notmatch '^[1-9]\d*$') { throw 'Please check napcat.dir and napcat.account in config.json' }
if (-not [IO.Path]::IsPathRooted($NapCatDir)) { $NapCatDir = Join-Path $BridgeDir $NapCatDir }
$exe = (Get-Item -LiteralPath (Join-Path $NapCatDir 'NapCatWinBootMain.exe') -ErrorAction Stop).FullName
$NapCatDir = Split-Path -Parent $exe
$napPrefix = $NapCatDir.TrimEnd('\') + '\'
if ($napPrefix -eq [IO.Path]::GetPathRoot($exe)) { throw 'Please point napcat.dir to a dedicated installation directory' }
$consolePort = if ($BridgeCfg.consolePort) { [int]$BridgeCfg.consolePort } else { 3100 }
$httpUrl = if ($BridgeCfg.snowluma.httpUrl) { [uri]$BridgeCfg.snowluma.httpUrl } else { [uri]'http://127.0.0.1:3000' }
if (-not $httpUrl.IsLoopback -or $httpUrl.Scheme -ne 'http') { throw 'Headless daemon requires a loopback OneBot HTTP URL' }
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

# NTQQ kernel liveness probe: get_stranger_info(no_cache=true) catches stale MSF sessions.
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
        $res = Invoke-RestMethod -Method Post -Uri ([uri]::new($httpUrl, '/get_status')) -MaximumRedirection 0 `
          -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } `
          -Body $body -TimeoutSec 8
        if ($res.status -eq 'ok' -and $res.data.online -eq $true) {
          return $true
        }
      } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in @(401,403,404)) {
          Write-Host '[ensure-daemons] Check the OneBot HTTP address and token. Keeping NapCat running.'
          return $null
        }
      }
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
  $procs = @(Get-HeadlessNapCat)
  if ($procs.Count -gt 0) {
    Write-Host "[ensure-daemons] Stopping headless NapCat processes ($($procs.ProcessId -join ','))..."
    foreach ($p in $procs) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    for ($w = 0; $w -lt 10; $w++) {
      Start-Sleep -Milliseconds 500
      if (-not (Test-LocalPort $httpPort) -and -not (Test-LocalPort $webuiPort)) { break }
    }
  }
}

$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly

# 1. Ensure Headless NapCat (isolated bot dataDir, never touches personal desktop QQ).
$napProc = @(Get-HeadlessNapCat)
$portsAlive = (Test-LocalPort $httpPort) -or (Test-LocalPort $webuiPort)

if (-not $ForceRestartNapCat -and ($napProc.Count -gt 0) -and (Test-LocalPort $httpPort)) {
  if ((Test-NapCatKernelAlive) -eq $false) {
    # Do not kill NapCat while QR scan or core initialization is still in progress.
    & $NodeExe "$BridgeDir\scripts\napcat-auto-relogin.mjs" --status-only *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host '[ensure-daemons] WebUI online but kernel probe failed twice. Restarting NapCat...'
      $ForceRestartNapCat = $true
    } else {
      Write-Host '[ensure-daemons] Login pending or WebUI unavailable. Preserving the current login.'
    }
  }
}

if ($ForceRestartNapCat -or (-not $portsAlive)) {
  Stop-HeadlessNapCatOnly
  Write-Host "[ensure-daemons] Starting headless NapCat ($BotQQ) via WMI (ShowWindow=0, NO_PROXY=*)..."
  $envParts = @('set NO_PROXY=*', 'set HTTP_PROXY=', 'set HTTPS_PROXY=', "set NAPCAT_QUICK_ACCOUNT=$BotQQ")
  if ($NapCfg.dataDir) {
    $dataDirPath = [string]$NapCfg.dataDir
    if (-not [IO.Path]::IsPathRooted($dataDirPath)) { $dataDirPath = Join-Path $BridgeDir $dataDirPath }
    $envParts += "set NAPCAT_DATA_DIR=$dataDirPath"
  }
  if ($NapCfg.userDataDir) {
    $userDataDirPath = [string]$NapCfg.userDataDir
    if (-not [IO.Path]::IsPathRooted($userDataDirPath)) { $userDataDirPath = Join-Path $BridgeDir $userDataDirPath }
    $envParts += "set NAPCAT_USER_DATA_DIR=$userDataDirPath"
  }
  $napCmd = 'cmd.exe /c "' + ($envParts -join '&& ') + '&& "' + $exe + '" ' + $BotQQ + '"'
  $r1 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $napCmd
    CurrentDirectory = $NapCatDir
    ProcessStartupInformation = $si
  }
  if ($r1.ReturnValue -ne 0) { throw "NapCat launch failed, WMI ReturnValue=$($r1.ReturnValue)" }
  Write-Host "[ensure-daemons] NapCat WMI launch ReturnValue=$($r1.ReturnValue) PID=$($r1.ProcessId)"
  for ($i = 0; $i -lt 28; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-LocalPort $httpPort) -or ($i -ge 6 -and (Test-LocalPort $webuiPort))) { break }
  }
  if (-not (Test-LocalPort $httpPort) -and (Test-LocalPort $webuiPort)) {
    & $NodeExe "$BridgeDir\scripts\napcat-auto-relogin.mjs" | Out-Host
  }
} else {
  Write-Host '[ensure-daemons] NapCat already running.'
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
  if ($r2.ReturnValue -ne 0) { throw "qq-bridge launch failed, WMI ReturnValue=$($r2.ReturnValue)" }
  Write-Host "[ensure-daemons] bridge.js WMI launch ReturnValue=$($r2.ReturnValue) PID=$($r2.ProcessId)"
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 600
    if (Test-LocalPort $consolePort) { break }
  }
  if (-not (Test-LocalPort $consolePort)) { throw "qq-bridge port $consolePort startup timed out, check state/bridge.log" }
} else {
  Write-Host "[ensure-daemons] qq-bridge (:$consolePort) already running."
}
# 3. Ensure QR Portal Daemon (127.0.0.1:3102 + cloudflared tunnel)
$qrPortalPort = if ($NapCfg.qrPortalPort) { [int]$NapCfg.qrPortalPort } else { 3102 }
if (-not (Test-LocalPort $qrPortalPort)) {
  Write-Host "[ensure-daemons] Starting hidden qr-portal-daemon (:$qrPortalPort) via WMI (ShowWindow=0)..."
  $qrCmd = "`"$NodeExe`" `"$BridgeDir\scripts\qr-portal-daemon.mjs`""
  $r3 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $qrCmd
    CurrentDirectory = $BridgeDir
    ProcessStartupInformation = $si
  }
  if ($r3.ReturnValue -ne 0) { throw "qr-portal-daemon launch failed, WMI ReturnValue=$($r3.ReturnValue)" }
  Write-Host "[ensure-daemons] qr-portal-daemon WMI launch ReturnValue=$($r3.ReturnValue) PID=$($r3.ProcessId)"
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-LocalPort $qrPortalPort) { break }
  }
} else {
  Write-Host "[ensure-daemons] qr-portal-daemon (:$qrPortalPort) already running."
}
