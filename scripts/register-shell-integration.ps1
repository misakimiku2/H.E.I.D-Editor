<#
.SYNOPSIS
  为已安装的 H.I.D.E 补齐 / 撤销 Windows 外壳集成注册。

.DESCRIPTION
  安装包在安装完成时会自动执行等价注册（见 src-tauri/nsis/installer-hooks.nsh）。
  本脚本用于不想重装的场景：
    · 已装旧版本，想立刻让 H.I.D.E 出现在「打开方式」「默认应用」里
    · 开发调试期间快速开关
  全部写入 HKCU，不需要管理员权限；-Unregister 可完整撤销。

  注意 1：注册表路径含 `*`（所有文件类型），必须用 -LiteralPath，
          否则 PowerShell 会按通配符解析并静默不写入。
  注意 2：Windows 10/11 禁止程序静默篡改「默认程序」（UserChoice 有哈希校验），
          因此脚本只负责把 H.I.D.E 注册为「候选」，最终设为默认仍需在
          设置 → 应用 → 默认应用 中手动选择一次。

.PARAMETER ExePath
  nexus-editor.exe 的完整路径。省略则自动探测。

.PARAMETER Unregister
  撤销本脚本写入的全部注册项。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/register-shell-integration.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/register-shell-integration.ps1 -Unregister
#>
[CmdletBinding()]
param(
  [string]$ExePath,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

# --- 常量：必须与 src-tauri/tauri.conf.json 保持一致 ---
$ProgId  = 'H.I.D.E Document'                    # = fileAssociations.name
$AppName = 'H.I.D.E'
$CapKey  = 'Software\H.I.D.E\Capabilities'
$ExeName = 'nexus-editor.exe'
$Verb    = 'HIDEOpen'

# 扩展名清单：需与 tauri.conf.json 的 bundle.fileAssociations 同步
$Extensions = @(
  'txt', 'log', 'md', 'markdown',
  'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'svg',
  'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'cs', 'rb', 'php',
  'html', 'htm', 'css', 'scss', 'less',
  'sh', 'bash', 'sql', 'swift', 'kt', 'kts', 'scala', 'vue', 'svelte'
)

function Resolve-EditorsExe {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) { throw "指定的可执行文件不存在: $Explicit" }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'H.I.D.E\nexus-editor.exe'),
    (Join-Path $env:ProgramFiles 'H.I.D.E\nexus-editor.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'H.I.D.E\nexus-editor.exe'),
    (Join-Path $PSScriptRoot '..\src-tauri\target\release\nexus-editor.exe'),
    (Join-Path $PSScriptRoot '..\src-tauri\target\debug\nexus-editor.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  throw "未找到 nexus-editor.exe，请用 -ExePath 指定路径。"
}

function New-RegKey {
  param([string]$Key)
  if (-not (Test-Path -LiteralPath $Key)) { New-Item -Path $Key -Force | Out-Null }
}

function Set-RegDefault {
  param([string]$Key, [string]$Value)
  New-RegKey $Key
  Set-ItemProperty -LiteralPath $Key -Name '(default)' -Value $Value
}

function Set-RegValue {
  param([string]$Key, [string]$Name, [string]$Value)
  New-RegKey $Key
  Set-ItemProperty -LiteralPath $Key -Name $Name -Value $Value
}

function Remove-RegKey {
  param([string]$Key)
  if (Test-Path -LiteralPath $Key) { Remove-Item -LiteralPath $Key -Recurse -Force }
}

function Remove-ShellRefresh {
  # SHChangeNotify(SHCNE_ASSOCCHANGED) —— 让资源管理器刷新关联缓存。
  # 仅属体验优化，失败不影响注册结果。
  try {
    if (-not ('Shell32.NativeMethods' -as [type])) {
      $sig = '[System.Runtime.InteropServices.DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, uint uFlags, System.IntPtr dwItem1, System.IntPtr dwItem2);'
      Add-Type -Namespace Shell32 -Name NativeMethods -MemberDefinition $sig | Out-Null
    }
    [Shell32.NativeMethods]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
  } catch {
    Write-Verbose "外壳刷新已跳过: $($_.Exception.Message)"
  }
}

$exe      = Resolve-EditorsExe -Explicit $ExePath
$exeKey   = "HKCU:\Software\Classes\Applications\$ExeName"
$appPaths = "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$ExeName"
$capRoot  = "HKCU:\$CapKey"
$menuKey  = "HKCU:\Software\Classes\*\shell\$Verb"

if ($Unregister) {
  Write-Host '撤销 H.I.D.E 外壳集成注册...'

  foreach ($ext in $Extensions) {
    Remove-ItemProperty -LiteralPath "HKCU:\Software\Classes\.$ext\OpenWithProgids" -Name $ProgId -ErrorAction SilentlyContinue
    Remove-ItemProperty -LiteralPath "$exeKey\SupportedTypes" -Name ".$ext" -ErrorAction SilentlyContinue
    Remove-ItemProperty -LiteralPath "$capRoot\FileAssociations" -Name ".$ext" -ErrorAction SilentlyContinue
  }

  Remove-RegKey $menuKey
  Remove-RegKey $exeKey
  Remove-RegKey $appPaths
  Remove-RegKey $capRoot
  Remove-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' -Name $AppName -ErrorAction SilentlyContinue

  # 仅在 Software\H.I.D.E 已空时移除，避免误删其他数据
  $parent = 'HKCU:\Software\H.I.D.E'
  if ((Test-Path -LiteralPath $parent) -and
      (-not (Get-ChildItem -LiteralPath $parent -Recurse -ErrorAction SilentlyContinue))) {
    Remove-Item -LiteralPath $parent -Force
  }

  Remove-ShellRefresh
  Write-Host '完成。H.I.D.E 已从「打开方式」「默认应用」与右键菜单中移除。' -ForegroundColor Green
  return
}

Write-Host '注册 H.I.D.E 外壳集成...' -ForegroundColor Cyan
Write-Host "  可执行文件: $exe"

# 1. 打开方式候选 + 按 exe 的可选编辑器 + 默认应用文件类型清单
foreach ($ext in $Extensions) {
  Set-RegValue -Key "HKCU:\Software\Classes\.$ext\OpenWithProgids" -Name $ProgId -Value ''
  Set-RegValue -Key "$exeKey\SupportedTypes" -Name ".$ext" -Value ''
  Set-RegValue -Key "$capRoot\FileAssociations" -Name ".$ext" -Value $ProgId
}

# 2. 按可执行文件注册：让系统按 exe 识别为可选编辑器
Set-RegDefault -Key $exeKey -Value $AppName
Set-RegValue -Key $exeKey -Name 'FriendlyAppName' -Value $AppName
Set-RegDefault -Key "$exeKey\DefaultIcon" -Value "$exe,0"
Set-RegDefault -Key "$exeKey\shell\open" -Value "Open with $AppName"
Set-RegDefault -Key "$exeKey\shell\open\command" -Value "`"$exe`" `"%1`""

# 3. App Paths：支持按 exe 名启动与定位
Set-RegDefault -Key $appPaths -Value $exe
Set-RegValue -Key $appPaths -Name 'Path' -Value (Split-Path -Parent $exe)

# 4. 默认应用清单（设置 → 默认应用 中可见）
Set-RegValue -Key 'HKCU:\Software\RegisteredApplications' -Name $AppName -Value $CapKey
Set-RegDefault -Key $capRoot -Value $AppName
Set-RegValue -Key $capRoot -Name 'ApplicationName' -Value $AppName
Set-RegValue -Key $capRoot -Name 'ApplicationDescription' -Value '秒开的轻量代码 / 文档编辑器'
Set-RegValue -Key $capRoot -Name 'ApplicationIcon' -Value "$exe,0"

# 5. 右键「用 H.I.D.E 打开」（所有文件类型）
Set-RegDefault -Key $menuKey -Value "用 $AppName 打开"
Set-RegValue -Key $menuKey -Name 'Icon' -Value "$exe,0"
Set-RegValue -Key $menuKey -Name 'MultiSelectModel' -Value 'Single'
Set-RegDefault -Key "$menuKey\command" -Value "`"$exe`" `"%1`""

Remove-ShellRefresh

Write-Host '完成。现在可以：' -ForegroundColor Green
Write-Host '  · 任意文件右键 → 打开方式 → 更多应用，应能看到 H.I.D.E'
Write-Host '  · 任意文件右键菜单出现「用 H.I.D.E 打开」'
Write-Host '  · 设置 → 应用 → 默认应用 列表中出现 H.I.D.E（设为默认需手动点一次）'
Write-Host "撤销：powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Unregister"
