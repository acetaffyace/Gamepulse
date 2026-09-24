# 注册 / 注销 Windows 计划任务
#
# 为什么是本机计划任务而不是 GitHub Actions：
#   Actions 的 runner 在境外。B 站接口对境外 IP 有风控（实测搜索接口
#   直接返回 HTTP 412），Steam 商店接口也会按 IP 跳区，导致同一个指标
#   在不同日子来自不同地区口径。数据一致性比"云端自动跑"重要得多。
#
# 代价：关机的时段会漏采。评测创建日可由后续回填补齐；无法回填的观测
#   仍在曲线上留空，由 quality 检查标出，不插值或编造在线人数。
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
$reviewRecovery = Join-Path $root "scripts\run-review-recovery.cmd"
$weeklyReviews = Join-Path $root "scripts\run-weekly-review-backfill.cmd"

$TASK_DAILY = "GamePulse-Daily"
$TASK_HOURLY = "GamePulse-HourlyOnline"
$TASK_REVIEW_RECOVERY = "GamePulse-ReviewRecovery"
$TASK_WEEKLY_REVIEWS = "GamePulse-WeeklyReviewBackfill"

function Show-Status {
    foreach ($name in @($TASK_DAILY, $TASK_HOURLY, $TASK_REVIEW_RECOVERY, $TASK_WEEKLY_REVIEWS)) {
        try {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
            $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
        } catch {
            if ($_.CategoryInfo.Category -eq "ObjectNotFound") {
                Write-Host ("  {0,-26} 未注册" -f $name)
            } else {
                Write-Warning ("  {0} 状态查询失败：{1}" -f $name, $_.Exception.Message)
            }
            continue
        }
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
    foreach ($name in @($TASK_DAILY, $TASK_HOURLY, $TASK_REVIEW_RECOVERY, $TASK_WEEKLY_REVIEWS)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "已删除 $name"
        }
    }
    exit 0
}

foreach ($path in @($daily, $hourly, $reviewRecovery, $weeklyReviews)) {
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

# 每日仅抓近期评测，修复临时接口超时留下的日缺口，
# 同时把版本滚动好评率追到当天。失败时计划任务一小时后自动重试一次。
$recoverySettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -RestartCount 1 `
    -RestartInterval (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew
$recoveryAction = New-ScheduledTaskAction -Execute $reviewRecovery -WorkingDirectory $root
$recoveryTrigger = New-ScheduledTaskTrigger -Daily -At "17:00"
Register-ScheduledTask -TaskName $TASK_REVIEW_RECOVERY `
    -Action $recoveryAction -Trigger $recoveryTrigger `
    -Settings $recoverySettings -Principal $principal -Force | Out-Null
Write-Host "已注册 $TASK_REVIEW_RECOVERY（每天 17:00，失败后重试一次）"

# 每周全量重新枚举仍存活的评测，校准日增量暂时保留的删除/编辑差异。
# 全量接口偶尔提前结束；采集器会拒绝部分结果，旧历史继续可用。
$weeklyAction = New-ScheduledTaskAction -Execute $weeklyReviews -WorkingDirectory $root
$weeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "18:00"
Register-ScheduledTask -TaskName $TASK_WEEKLY_REVIEWS `
    -Action $weeklyAction -Trigger $weeklyTrigger `
    -Settings $recoverySettings -Principal $principal -Force | Out-Null
Write-Host "已注册 $TASK_WEEKLY_REVIEWS（每周日 18:00）"

Write-Host "`n当前状态：`n"
Show-Status

Write-Host @"

提示
  · 日志在 data\logs\，按日期分文件；
  · 每天 17:00 增量回填近期评测；每周日 18:00 全量校准；失败会重试并保留旧数据；
  · YouTube 需要 API Key 才会采集。计划任务读不到你终端里 set 的变量，
    要用 setx 写进用户环境变量：  setx YOUTUBE_API_KEY "你的密钥"
    设完要重新注册任务或重启，任务才能读到；
  · 关机时段的评测创建日可回填；无法回填的在线观测仍留空，不插值或填 0；
  · 随时可以手动补跑：python collect.py
"@
