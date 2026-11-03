# 将插件安装到 Antigravity：复制 agy-plugin/ 到 ~/.gemini/config/plugins/qq-bridge，并把 <QQ_BRIDGE_DIR> 替换成本仓库的实际路径。
param(
  [string]$Target = (Join-Path $HOME '.gemini\config\plugins\qq-bridge')
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $Target -Recurse -Force -Exclude 'install.ps1', 'README.md'
$escaped = $Repo.Replace('\', '\\')
Get-ChildItem $Target -Recurse -File -Include *.md, *.json | ForEach-Object {
  $text = [IO.File]::ReadAllText($_.FullName)
  $value = if ($_.Extension -eq '.json') { $escaped } else { $Repo }
  [IO.File]::WriteAllText($_.FullName, $text.Replace('<QQ_BRIDGE_DIR>', $value), (New-Object Text.UTF8Encoding $false))
}
Write-Host "[agy-plugin] 已安装到 $Target（仓库路径 $Repo）。在 Antigravity 插件管理里启用 qq-bridge 即可。"
