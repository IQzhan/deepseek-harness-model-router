# 验收"正在运行的"部署：读一次健康面，并把"接管是否真的生效"判成 PASS/FAIL。
#
# 为什么单独一个脚本：离线全绿不等于真环境可用，而 Host 半边是**进程内**加载的
# ——改了代码必须重启 `dsh web` 才会生效。重启后想知道"到底生效了没有"，只需要跑这一条。
#
#   pwsh -File verify-live.ps1                 # 默认 http://127.0.0.1:3080
#   pwsh -File verify-live.ps1 -Port 3081
#   pwsh -File verify-live.ps1 -Json           # 额外打印原始 JSON
#
# 它只读、不写：不会碰配置、不会碰会话、不花 token。
# 委派链路的端到端验证（关键词/分类器/[task:] 命中）需要在真实会话里派一次子智能体，
# 那一步由 agent 在会话内完成，见 skills/model-routing/SKILL.md。
param(
  [int]$Port = 3080,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:$Port/api/dsh-model-router"

$failures = 0
function Check([string]$label, [bool]$ok, [string]$detail = "") {
  if ($ok) {
    Write-Host "PASS  $label" -ForegroundColor Green
  } else {
    Write-Host "FAIL  $label  $detail" -ForegroundColor Red
    $script:failures++
  }
}

try {
  $health = (Invoke-WebRequest "$base/health" -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
} catch {
  Write-Host "FAIL  Host 半边没有回应（$base/health）" -ForegroundColor Red
  Write-Host "      设置页会把它显示成「Host 半边可能没有挂载或已崩溃」。" -ForegroundColor DarkGray
  Write-Host "      可能原因：插件行被 disabled、profile 没挂上、或进程还没起来。" -ForegroundColor DarkGray
  exit 1
}

if ($Json) { $health | ConvertTo-Json -Depth 8 }

Check "Host 半边在线" ($health.ok -eq $true) "(ok=$($health.ok))"
Check "路由总开关已启用" ($health.routing.enabled -eq $true) "(enabled=$($health.routing.enabled))"
Check "至少有一个任务" ([int]$health.routing.tasks -gt 0) "(tasks=$($health.routing.tasks))"
Check "委派服务在插件作用域里可见" ($health.delegation.service -eq $true) `
  "(service=$($health.delegation.service) → 找不到 subagents.start，安装根本不会开始)"
Check "熔断未跳闸" ($health.breaker.tripped -ne $true) "($($health.breaker.reason))"

# 每个"被授权且还活着"的 agent 都必须真的挑起了接管。这是本脚本的核心断言：
# 曾经出现过 installed: 0 / owned: false，而工具其实已经在会话里工作的情况——
# 根因是拿"异步启动跑没跑"当了登记条件（见 docs/design-notes.md 5.2.2(d)）。
$granted = @($health.delegation.agents | Where-Object { $_.granted -eq $true })
foreach ($agent in $granted) {
  $who = "$($agent.preset) [$($agent.origin)] $($agent.id)"
  Check "已授权会话被本插件接管：$who" ($agent.owned -eq $true) "(owned=$($agent.owned))"
  Check "该会话的接管真的启动了：$who" ($agent.applied -eq $true) `
    "(applied=$($agent.applied)$(if ($agent.error) { " · error=$($agent.error)" } else { '' }))"
}

$installed = [int]$health.delegation.installed
$applied = [int]$health.delegation.applied
if ($installed -gt 0) {
  Check "登记的 fiber 全部启动完成（applied == installed）" ($applied -eq $installed) `
    "(applied=$applied, installed=$installed → 有 fiber 挂在那里没起来)"
} else {
  Check "已授权会话存在时才有挂载数（此处无已授权会话）" ($granted.Count -eq 0) `
    "(installed=0 却有 $($granted.Count) 个已授权会话)"
}

$errors = @($health.errors)
Check "最近没有 Host 侧报错" ($errors.Count -eq 0) "($($errors | ForEach-Object { $_.where }) -join ', ')"
foreach ($entry in $errors) {
  Write-Host "      [$($entry.where)] $($entry.message)" -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "配置来源 : $($health.configuration.source)  $($health.configuration.root)" -ForegroundColor DarkGray
Write-Host "配置文件 : $($health.configuration.files -join ', ')" -ForegroundColor DarkGray
Write-Host "委派接管 : 已生效 $applied / 已挂载 $installed 个会话 · 子智能体可再分发=$($health.delegation.childDelegation)" -ForegroundColor DarkGray
Write-Host "能力探测 : $(($health.capabilities.PSObject.Properties | Where-Object { $_.Value -ne $true } | ForEach-Object { $_.Name }) -join ', ')$(if (-not ($health.capabilities.PSObject.Properties | Where-Object { $_.Value -ne $true })) { '全部就位' })" -ForegroundColor DarkGray

if ($failures -gt 0) {
  Write-Host ""
  Write-Host "$failures 项未通过。" -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "全部通过：接管已生效。" -ForegroundColor Green
