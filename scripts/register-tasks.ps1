# 注册 / 注销 Windows 计划任务
#
# 为什么是本机计划任务而不是 GitHub Actions：
#   Actions 的 runner 在境外。B 站接口对境外 IP 有风控（实测搜索接口
#   直接返回 HTTP 412），Steam 商店接口也会按 IP 跳区，导致同一个指标
#   在不同日子来自不同地区口径。数据一致性比"云端自动跑"重要得多。
#
# 代价：关机的时段会漏采。漏采的日期在曲线上是断点，由 quality 检查标出来，
#   不插值、不填 0 —— 这比一条看起来连续、实际上是编出来的曲线诚实。
#
# 用法（普通权限即可，任务注册在当前用户下）：
#   powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Remove
#   powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Status

param(
    [switch]$Remove,
    [switch]$Status,
    # 每日采集时间。默认 13:20 —— 避开整点，也避开 Steam 的凌晨维护窗口。
    [string]$DailyAt = "13:20"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$daily = Join-Path $root "scripts\run-daily.cmd"
$hourly = Join-Path $root "scripts\run-hourly.cmd"

$TASK_DAILY = "GamePulse-Daily"
$TASK_HOURLY = "GamePulse-HourlyOnline"

function Show-Status {
    foreach ($name in @($TASK_DAILY, $TASK_HOURLY)) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) {
            Write-Host ("  {0,-26} 未注册" -f $name)
            continue
        }
        $info = Get-ScheduledTaskInfo -TaskName $name
        Write-Host ("  {0,-26} {1}  上次 {2}  结果 {3}  下次 {4}" -f `
            $name, $task.State, $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime)
    }
}

if ($Status) {
    Write-Host "`nGamePulse 计划任务状态：`n"
    Show-Status
    Write-Host ""
    exit 0
}

if ($Remove) {
    foreach ($name in @($TASK_DAILY, $TASK_HOURLY)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "已删除 $name"
        }
    }
    exit 0
}

foreach ($path in @($daily, $hourly)) {
    if (-not (Test-Path $path)) { throw "找不到 $path" }
}

# 通用设置：
#   StartWhenAvailable  开机较晚时补跑错过的那次，而不是干脆跳过
#   DontStopOnIdleEnd   不因为你开始用电脑就把任务掐掉
#   ExecutionTimeLimit  卡住的任务 1 小时后强制结束，避免堆积
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

# 每日采集
$dailyAction = New-ScheduledTaskAction -Execute $daily -WorkingDirectory $root
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
Register-ScheduledTask -TaskName $TASK_DAILY `
    -Action $dailyAction -Trigger $dailyTrigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "已注册 $TASK_DAILY（每天 $DailyAt）"

# 小时级在线采样：从 00:05 起每小时一次。
# 错开整点是因为整点是各类定时任务最拥挤的时刻，也避免和每日任务撞上。
$hourlyAction = New-ScheduledTaskAction -Execute $hourly -WorkingDirectory $root
$hourlyTrigger = New-ScheduledTaskTrigger -Once -At "00:05" `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $TASK_HOURLY `
    -Action $hourlyAction -Trigger $hourlyTrigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "已注册 $TASK_HOURLY（每小时第 5 分钟）"

Write-Host "`n当前状态：`n"
Show-Status

Write-Host @"

提示
  · 日志在 data\logs\，按日期分文件；
  · YouTube 需要 API Key 才会采集。计划任务读不到你终端里 set 的变量，
    要用 setx 写进用户环境变量：  setx YOUTUBE_API_KEY "你的密钥"
    设完要重新注册任务或重启，任务才能读到；
  · 关机时段会漏采，漏采日期在图上是断点，不会被插值或填 0；
  · 随时可以手动补跑：python collect.py
"@
