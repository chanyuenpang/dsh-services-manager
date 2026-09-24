<#
.SYNOPSIS
  启动/复用隔离沙箱实例，并打印可供你在浏览器里预览的地址。

.DESCRIPTION
  只碰隔离的 DSH_HOME（`.sandbox\dsh-home`）与端口 3099，**绝不触碰正式 profile（3080）**。
  这是 AGENTS.md 里「先沙箱、后正式」那条硬约束的操作化入口。

.EXAMPLE
  pwsh -File scripts/preview-sandbox.ps1            # 启动并打印预览地址
  pwsh -File scripts/preview-sandbox.ps1 -Stop      # 停掉沙箱实例
#>
[CmdletBinding()]
param(
  [int]$Port = 3099,
  [string]$Profile = 'sandbox',
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sandboxHome = Join-Path $root '.sandbox\dsh-home'
$logDir = Join-Path $root '.sandbox\logs'
$logPath = Join-Path $logDir 'sandbox-preview.log'

function Get-PortOwner([int]$p) {
  $connection = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $connection) { return $null }
  return $connection.OwningProcess
}

if ($Stop) {
  $owner = Get-PortOwner $Port
  if ($null -eq $owner) { Write-Host "端口 $Port 上没有实例，无需停止。"; exit 0 }
  taskkill /PID $owner /T /F | Out-Null
  Write-Host "已停止沙箱实例（pid $owner，端口 $Port）。"
  exit 0
}

$existing = Get-PortOwner $Port
if ($null -ne $existing) {
  Write-Host "端口 $Port 上已有实例（pid $existing）——直接复用。"
} else {
  if (-not (Test-Path $sandboxHome)) {
    Write-Error "沙箱 DSH_HOME 不存在：$sandboxHome（先按 AGENTS.md 建 profile 并安装插件）"
    exit 1
  }
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $env:DSH_HOME = $sandboxHome
  # 子 pwsh 的控制台编码必须是 UTF-8，否则它会把 dsh 的 UTF-8 输出按 ANSI 解码后再写盘（中文变乱码）。
  $prefix = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; '
  $inner = $prefix + "dsh --profile $Profile --port $Port --no-open *>&1 | Out-File -FilePath '$logPath' -Encoding utf8BOM"
  Start-Process -FilePath 'pwsh' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', $inner) | Out-Null
  Write-Host "正在启动沙箱实例（DSH_HOME=$sandboxHome，端口 $Port）…"
}

# 等实例打印带 token 的地址（新实例才会重新打印）
$url = $null
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
  Start-Sleep -Seconds 1
  if (Test-Path $logPath) {
    $match = Select-String -Path $logPath -Pattern "http://127\.0\.0\.1:$Port/\?token=\S+" | Select-Object -Last 1
    if ($null -ne $match) { $url = $match.Matches.Value; break }
  }
}

if ($null -eq $url) {
  Write-Warning "没等到 token 地址（60s）。看日志：$logPath"
  Write-Host "（复用已有实例时日志里可能没有新地址；token 在实例自己的输出里）"
  exit 1
}

Write-Host ''
Write-Host '预览地址（在浏览器打开；只影响沙箱，你的正式页面不受影响）：' -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Green
Write-Host ''
Write-Host "看完停掉：pwsh -File scripts/preview-sandbox.ps1 -Stop"
Write-Host "日志：$logPath"
