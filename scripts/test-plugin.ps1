<#
.SYNOPSIS
  在指定版本的 DSH 上安装本插件并做兼容性验证（不动你正在用的桌面端）。

.DESCRIPTION
  每个版本使用独立目录 + 独立 DSH_HOME，互不干扰：
    1. 用 Node/pnpm 安装 @deepseek-ai/dsh@<Version>
    2. 在独立 DSH_HOME 下从 web 模板初始化 profile
    3. 把本插件以 file: 依赖装进该 profile（dsh 会自动写入 dsh.profile.bundles）
    4. 打印组合结果，可选启动 Web UI

  装完后用 check-plugin.ps1 对该端口跑冒烟测试。

.PARAMETER Version
  要测试的 DSH 版本，如 0.2.1-rc.2 / 0.2.2-rc.1。

.PARAMETER PluginPath
  本插件目录，默认是脚本所在仓库的根目录。

.PARAMETER Port
  Web UI 端口，默认 6123（别和桌面端冲突）。

.PARAMETER Root
  测试安装根目录，默认 %TEMP%\dsh-verify。

.PARAMETER Reinstall
  强制重装插件（改了 lib/ 之后用）。

.PARAMETER NoBoot
  只安装并打印组合结果，不启动 Web UI。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-plugin.ps1 -Version 0.2.1-rc.2
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$PluginPath = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 6123,
  [string]$Root = (Join-Path $env:TEMP "dsh-verify"),
  [switch]$Reinstall,
  [switch]$NoBoot
)

$ErrorActionPreference = "Stop"

function Find-DshNode {
  $candidates = @()
  if ($env:DSH_NODE) { $candidates += $env:DSH_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  foreach ($base in @("D:\DeepseekHarness", (Join-Path $env:ProgramFiles "DeepSeek Harness"), (Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness"))) {
    if ($base) { $candidates += (Join-Path $base "resources\runtime\primary-runtime\dependencies\node\bin\node.exe") }
  }
  foreach ($c in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path $c)) { continue }
    try { $major = [int](((& $c --version) -replace '^v', '').Split('.')[0]) } catch { continue }
    if ($major -ge 20) { return $c }
  }
  throw "找不到 Node >= 20。安装 Node 20+，或设置 DSH_NODE 指向 node.exe。"
}

$node = Find-DshNode
Write-Host "== Node: $node" -ForegroundColor DarkGray

# dsh 的 plugin 子命令会直接调 PATH 上的 pnpm；没有就用 DSH 自带的那份做 shim
$shimDir = Join-Path $Root "bin"
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  $nodeDir = Split-Path (Split-Path $node -Parent) -Parent
  $pnpmCjs = Join-Path $nodeDir "pnpm\bin\pnpm.cjs"
  if (-not (Test-Path $pnpmCjs)) { throw "PATH 上没有 pnpm，且找不到 DSH 自带的 pnpm：$pnpmCjs" }
  $shim = Join-Path $shimDir "pnpm.cmd"
  "@echo off`r`n""$node"" ""$pnpmCjs"" %*" | Set-Content -Path $shim -Encoding ASCII
  $env:PATH = "$shimDir;$env:PATH"
}

$dir = Join-Path $Root $Version
$homeDir = Join-Path $Root "home-$Version"
New-Item -ItemType Directory -Force -Path $dir, $homeDir | Out-Null
$env:DSH_HOME = $homeDir
$bin = Join-Path $dir "node_modules\@deepseek-ai\dsh\lib\bin.js"

# 1) 安装指定版本的 dsh CLI
if (-not (Test-Path $bin)) {
  Write-Host "== 安装 @deepseek-ai/dsh@$Version ..." -ForegroundColor Cyan
  '{"name":"dsh-verify","private":true,"version":"0.0.0"}' |
    Set-Content -Path (Join-Path $dir "package.json") -Encoding UTF8
  & pnpm add "@deepseek-ai/dsh@$Version" --dir $dir --reporter=append-only | Out-Null
  if (-not (Test-Path $bin)) { throw "安装失败，未找到 $bin" }
}
$actual = (Get-Content (Join-Path $dir "node_modules\@deepseek-ai\dsh\package.json") -Raw | ConvertFrom-Json).version
Write-Host "== dsh 版本: $actual" -ForegroundColor Green

# 2) 初始化 web 模板 profile（名字按版本生成，如 t021rc2）
$profile = "t" + ($Version -replace '[\.\-]', '')
if (-not (Test-Path (Join-Path $homeDir "profiles\$profile\package.json"))) {
  Write-Host "== 初始化 profile $profile ..." -ForegroundColor Cyan
  & $node $bin --profile $profile --from-default-profile web --dump-config | Out-Null
}

# 3) 装插件（file: 依赖，dsh 会自动加进 dsh.profile.bundles）
$pkg = Get-Content (Join-Path $PluginPath "package.json") -Raw | ConvertFrom-Json
$spec = "file:" + ($PluginPath -replace '\\', '/')
$installed = Join-Path $homeDir "profiles\$profile\node_modules\$($pkg.name)"
if (-not (Test-Path $installed) -or $Reinstall) {
  Write-Host "== 安装插件 $($pkg.name)@$($pkg.version) ..." -ForegroundColor Cyan
  $extra = @()
  if ($Reinstall) { $extra += "--force" }
  & $node $bin plugin --profile $profile add $spec @extra | Select-Object -Last 3
}

# 4) 自检：组合后的配置里应当出现插件行
Write-Host "`n== 组合结果（应看到 ui-sidebar-reader / $($pkg.name)） ==" -ForegroundColor Green
& $node $bin --profile $profile --dump-config |
  Select-String -Pattern "$($pkg.name)|ui-sidebar-reader" | ForEach-Object { $_.Line }

Write-Host "`nprofile 目录: $(Join-Path $homeDir "profiles\$profile")"
if ($NoBoot) { Write-Host "已跳过启动（-NoBoot）"; return }

Write-Host "`n== 启动 http://127.0.0.1:$Port/ ..." -ForegroundColor Cyan
Write-Host "   起来后另开一个终端跑：scripts/check-plugin.ps1 -Port $Port" -ForegroundColor DarkGray
& $node $bin --profile $profile --port $Port --no-open
