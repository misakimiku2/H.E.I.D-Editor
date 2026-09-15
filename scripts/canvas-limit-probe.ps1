# 开发用探针：用 headless 浏览器实测 2D canvas 的最大可用尺寸（结果与结论见 canvas-limit-probe.html 顶部注释）。
#   用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/canvas-limit-probe.ps1
#   换 Chrome 内核：-Browser "C:\Program Files\Google\Chrome\Application\chrome.exe"
param(
  [string]$Browser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
)

$ErrorActionPreference = 'Continue'

# 复制到无空格路径（file:// 对空格路径兼容性差）
$dst = Join-Path $env:TEMP 'canvas-limit-probe.html'
Copy-Item (Join-Path $PSScriptRoot 'canvas-limit-probe.html') $dst -Force
$url = 'file:///' + ($dst -replace '\\', '/')
$outFile = Join-Path $env:TEMP 'canvas-limit-probe-dump.html'
$errFile = Join-Path $env:TEMP 'canvas-limit-probe-dump.err'

if (Test-Path $outFile) { Remove-Item $outFile -Force }
if (Test-Path $errFile) { Remove-Item $errFile -Force }

$proc = Start-Process -FilePath $Browser -NoNewWindow -Wait -PassThru `
  -ArgumentList @('--headless=new', '--dump-dom', '--no-sandbox', $url) `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile

$txt = if (Test-Path $outFile) { Get-Content $outFile -Raw } else { $null }
Write-Output "exit=$($proc.ExitCode) url=$url stdoutLen=$(if ($txt) { $txt.Length } else { 0 })"

if ($txt) {
  $start = $txt.IndexOf('CANVAS-PROBE-START')
  $end = $txt.IndexOf('CANVAS-PROBE-END')
  if ($start -ge 0 -and $end -gt $start) {
    Write-Output $txt.Substring($start, $end - $start + 17)
  } else {
    Write-Output $txt.Substring(0, [Math]::Min(1200, $txt.Length))
  }
} else {
  Write-Output 'NO STDOUT; stderr tail:'
  if (Test-Path $errFile) { Get-Content $errFile -Tail 10 }
}
