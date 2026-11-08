<#
.SYNOPSIS
  dsh-sidebar-reader 冒烟测试：确认宿主路由活着、客户端在轮询、快照能拿到。

.DESCRIPTION
  纯 HTTP 通道验证，不依赖模型工具，可在任意端口跑（桌面端 / CLI 起来的 Web UI 都行）：
    1. GET  /sidebar-reader/health   插件是否加载
    2. POST /sidebar-reader/command  下发一次采集命令
    3. GET  /sidebar-reader/latest   轮询等待客户端回传快照
  最后按结果给出判读与下一步建议，成功 exit 0，失败 exit 1。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\check-plugin.ps1 -Port 53233
  powershell -NoProfile -ExecutionPolicy Bypass -File .\check-plugin.ps1 -Port 6123 -TimeoutSec 20
#>
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [int]$TimeoutSec = 15
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:$Port"
$fail = 0

function Say($text, $color = "Gray") { Write-Host $text -ForegroundColor $color }

# 1) 宿主路由
try {
  $health = (Invoke-WebRequest -UseBasicParsing "$base/sidebar-reader/health" -TimeoutSec 8).Content | ConvertFrom-Json
  Say "[1/3] health  : OK  hasSnapshot=$($health.hasSnapshot)" "Green"
} catch {
  Say "[1/3] health  : FAIL —— 插件没加载（404）或端口不对：$($_.Exception.Message)" "Red"
  Say "     检查：profile 的 dsh.profile.bundles 是否含包名；改完配置后是否重启过应用。" "Yellow"
  exit 1
}

# 2) 下发采集命令
try {
  $null = Invoke-WebRequest -UseBasicParsing -Method Post "$base/sidebar-reader/command" `
    -ContentType "application/json" -Body '{}' -TimeoutSec 8
  Say "[2/3] command : 已下发" "Green"
} catch {
  Say "[2/3] command : FAIL —— $($_.Exception.Message)" "Red"
  exit 1
}

# 3) 等待客户端回传
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$snap = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 600
  try {
    $snap = (Invoke-WebRequest -UseBasicParsing "$base/sidebar-reader/latest" -TimeoutSec 5).Content | ConvertFrom-Json
    if ($snap.commandId) { break }
  } catch { }
}

if (-not $snap -or -not $snap.commandId) {
  Say "[3/3] latest  : FAIL —— $TimeoutSec 秒内客户端没有回传，采集超时" "Red"
  Say "     含义：宿主的 sidebar_read 工具/路由在，但页面里的客户端模块没跑起来。" "Yellow"
  Say "     最常见原因：lib/client.js 里 __ModuleLoader__.load 的 id 与包名不一致。" "Yellow"
  Say "     次要原因：GUI 页面被关闭/最小化（document.visibilityState=hidden 时会跳过轮询）。" "Yellow"
  exit 1
}

# 判读快照
$tabs = @($snap.right.tabs).Count
$terms = @($snap.terminals.terminals).Count
$hasPage = $null -ne $snap.page
Say "[3/3] latest  : OK  （commandId 对上了）" "Green"
Say ""
Say "快照摘要：" "Cyan"
Say "  右侧栏标签 : $tabs 个"
Say "  终端       : $terms 个"
Say "  网页正文   : $(if ($hasPage) { "有（$($snap.page.chars) 字）" } else { "无" })"
if ($snap.right.error) { Say "  右侧栏错误 : $($snap.right.error)" "Yellow" }
if ($snap.terminals.error) { Say "  终端错误   : $($snap.terminals.error)" "Yellow" }
Say ""
if ($tabs -eq 0 -and $terms -eq 0 -and -not $hasPage) {
  Say "结论：链路通，但当前会话没有可读内容（没开标签/终端/侧栏网页）。" "Yellow"
  Say "      验证数据面：在侧栏打开一个文件标签、开一个终端，再跑一次本脚本。" "Yellow"
} else {
  Say "结论：插件工作正常（宿主 + 客户端 + 数据三通道）。" "Green"
}
exit 0
