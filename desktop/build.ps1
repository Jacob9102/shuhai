<#
  书海 · 桌面版打包脚本

  把「零依赖的 Node 服务」打包成一个绿色免安装的 Windows 软件：
      runtime\node.exe   ← 自带运行时，目标电脑不用装 Node
      app\               ← 服务源码 + 前端
      data\              ← 书源 / 书架 / 阅读进度（SQLite）
      书海.exe           ← 启动器：托盘图标 + 一键启动 + 自动开浏览器
      config.ini         ← 端口等配置

  用法：
      powershell -ExecutionPolicy Bypass -File build.ps1
      powershell -ExecutionPolicy Bypass -File build.ps1 -WithData   # 连现有书源数据一起打包

  重复执行是安全的：只会重建 app/ 和 runtime/，data/ 与 config.ini 永远保留。
#>

param(
    [string]$SourceDir,
    [string]$OutDir,
    [string]$NodeExe,
    [switch]$WithData
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
# 仓库是摊平结构：desktop/ 与项目源码平级，都躺在仓库根目录下
$projectRoot = Split-Path $scriptDir -Parent

if (-not $SourceDir) { $SourceDir = $projectRoot }
if (-not $OutDir)    { $OutDir    = Join-Path $projectRoot 'dist\书海' }
if (-not $NodeExe) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source } else { $NodeExe = 'C:\Program Files\nodejs\node.exe' }
}

# ------------------------------------------------------------------ 前置检查

if (-not (Test-Path (Join-Path $SourceDir 'package.json'))) {
    throw "找不到项目源码：$SourceDir（应当包含 package.json / src / web）"
}
if (-not (Test-Path $NodeExe)) {
    throw "找不到 Node 可执行文件：$NodeExe，请用 -NodeExe 指定"
}

$fullOut = [System.IO.Path]::GetFullPath($OutDir)
$fullRoot = [System.IO.Path]::GetFullPath($projectRoot)
if ($fullOut -eq $fullRoot -or -not $fullOut.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "输出目录必须位于 $fullRoot 之内，当前为 $fullOut"
}

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "找不到 C# 编译器：$csc（这是 Windows 自带的 .NET Framework 组件）" }

# 所有文本文件统一用 UTF-8：bat 不能带 BOM（cmd 会把 BOM 当命令），其余带 BOM 方便记事本识别
$utf8Bom    = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

Write-Host '== 书海 桌面版打包 ==' -ForegroundColor Cyan
Write-Host ("源码: {0}" -f $SourceDir)
Write-Host ("输出: {0}" -f $fullOut)
Write-Host ("Node: {0}" -f $NodeExe)

# ------------------------------------------------------------ 目录与文件搬运

$appOut     = Join-Path $fullOut 'app'
$runtimeOut = Join-Path $fullOut 'runtime'
$dataOut    = Join-Path $fullOut 'data'

# 只重建程序本体；data/ 和 config.ini 是用户数据，绝不动
foreach ($dir in @($appOut, $runtimeOut)) {
    if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}
foreach ($dir in @($fullOut, $appOut, $runtimeOut, $dataOut)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

Copy-Item -LiteralPath (Join-Path $SourceDir 'package.json') -Destination $appOut -Force
Copy-Item -LiteralPath (Join-Path $SourceDir 'src') -Destination $appOut -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SourceDir 'web') -Destination $appOut -Recurse -Force
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $runtimeOut 'node.exe') -Force

if ($WithData) {
    $srcDb = Join-Path $SourceDir 'data\shuhai.db'
    $dstDb = Join-Path $dataOut 'shuhai.db'
    if ((Test-Path $srcDb) -and -not (Test-Path $dstDb)) {
        Copy-Item -LiteralPath $srcDb -Destination $dstDb -Force
        # 顺带把 WAL 里还没落盘的数据一起带上，避免少掉最后几笔写入。
        # 只带 -wal 不带 -shm：-shm 是共享内存索引，SQLite 会自己重建，
        # 带过去反而可能和新的 -wal 对不上。
        $wal = Join-Path $SourceDir 'data\shuhai.db-wal'
        if (Test-Path $wal) { Copy-Item -LiteralPath $wal -Destination (Join-Path $dataOut 'shuhai.db-wal') -Force }
        Write-Host '  · 已带上现有书源/书架数据' -ForegroundColor DarkGray
    }
}

# ------------------------------------------------------------------ 图标

$iconPath = Join-Path $scriptDir 'app.ico'
& (Join-Path $scriptDir 'make-icon.ps1') -Out $iconPath -PreviewPng (Join-Path $scriptDir 'app-preview.png') | Out-Null

# 把网页里那个内联 SVG 图标换成真正的 .ico：独立窗口在任务栏、Alt-Tab 里的图标会更清晰
Copy-Item -LiteralPath $iconPath -Destination (Join-Path $appOut 'web\favicon.ico') -Force
$indexPath = Join-Path $appOut 'web\index.html'
if (Test-Path $indexPath) {
    $html = [System.IO.File]::ReadAllText($indexPath)
    $patched = $html -replace '<link rel="icon"[^>]*>', '<link rel="icon" href="/favicon.ico" sizes="any">'
    if ($patched -ne $html) {
        [System.IO.File]::WriteAllText($indexPath, $patched, $utf8NoBom)
        Write-Host '  · 网页图标已指向 favicon.ico' -ForegroundColor DarkGray
    }
}

# ------------------------------------------------------------------ 编译启动器

$exePath = Join-Path $fullOut '书海.exe'
& $csc /nologo /target:winexe /optimize+ /codepage:65001 `
    "/out:$exePath" `
    "/win32icon:$iconPath" `
    "/resource:$iconPath,shuhai.ico" `
    /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    (Join-Path $scriptDir 'ShuHaiLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw "启动器编译失败（csc 退出码 $LASTEXITCODE）" }
Write-Host '  · 启动器已编译' -ForegroundColor DarkGray

# ------------------------------------------------------------------ 配置与说明

$configPath = Join-Path $fullOut 'config.ini'
$configText = @'
# 书海 桌面版配置（改完保存，重新启动「书海.exe」生效）

# 服务端口。被占用时启动器会自动往后找一个空闲端口
port=8080

# 监听地址：
#   127.0.0.1  = 只有本机能访问（默认，不会触发 Windows 防火墙弹窗）
#   0.0.0.0    = 手机、平板等同一局域网设备也能访问 http://电脑IP:8080
host=127.0.0.1

# 启动后是否自动打开界面：1 打开，0 不打开
open_browser=1

# 界面容器：
#   app     = 独立窗口（默认）：用 Edge/Chrome 的应用模式，没有标签页和地址栏
#   browser = 用系统默认浏览器开标签页
window=app

# 关掉窗口之后：
#   exit = 整个软件退出（默认，最接近普通桌面软件的手感）
#   tray = 缩到右下角托盘继续后台运行，下次打开秒开
close_action=exit
'@

if (-not (Test-Path $configPath)) {
    [System.IO.File]::WriteAllText($configPath, $configText, $utf8Bom)
}
else {
    # 已有配置保留用户改动，只把新增的项补进去（按「注释块 + key=value」为单位）
    $groups = @()
    $pending = @()
    foreach ($line in ($configText -split "`r?`n")) {
        if ($line -match '^\s*#') { $pending += $line; continue }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
            $pending += $line
            $groups += , @{ Key = $Matches[1]; Text = ($pending -join "`r`n") }
            $pending = @()
        }
        else { $pending = @() }
    }

    $existing = [System.IO.File]::ReadAllText($configPath)
    $missing = @()
    foreach ($g in $groups) {
        if ($existing -notmatch ('(?m)^\s*' + [System.Text.RegularExpressions.Regex]::Escape($g.Key) + '\s*=')) {
            $missing += $g.Text
        }
    }
    if ($missing.Count -gt 0) {
        $append = "`r`n# ---------- 升级新增的可选项 ----------`r`n" + ($missing -join "`r`n`r`n") + "`r`n"
        [System.IO.File]::AppendAllText($configPath, $append, $utf8Bom)
        Write-Host ("  · config.ini 补写了 {0} 个新配置项" -f $missing.Count) -ForegroundColor DarkGray
    }
}

$readmePath = Join-Path $fullOut '使用说明.txt'
$readmeText = @'
书海 · 桌面版（绿色免安装）
=====================================

【怎么用】
双击「书海.exe」→ 稍等几秒，会弹出书海自己的独立窗口：
没有标签页、没有地址栏，任务栏上是单独一个图标，跟普通桌面软件一样。
搜索、书架、书源、阅读器全都在这个窗口里。
右下角托盘里还有一个书海图标，双击它可以把窗口叫回来。

【怎么退出】
直接关掉窗口，软件就整体退出了；也可以右键托盘图标 → 退出书海。
想让关窗后继续在后台跑（下次打开秒开），把 config.ini 的 close_action 改成 tray。

【数据在哪】
本目录下的 data\ 文件夹，里面是 SQLite 数据库，装着书源、书架、阅读进度、阅读设置。
  · 备份：整个 data 文件夹复制走即可
  · 迁移：把 data 文件夹拷到新电脑的同名目录
  · 重来：删掉 data 文件夹，下次启动会自动重建一个空库
  · data\browser-profile 是独立窗口自己的缓存目录（与你的日常浏览器互相隔离），
    删掉只会让窗口回到默认大小，书源和阅读记录都不受影响

【怎么换端口 / 换窗口样式 / 让手机也能看】
编辑 config.ini：
  port=8080        换端口（被占用时启动器会自动往后找一个空闲端口）
  host=0.0.0.0     手机、平板等同一局域网设备可访问 http://电脑IP:端口
  open_browser=0   启动后不自动开界面
  window=browser   改回用默认浏览器开标签页（默认 window=app 是独立窗口）
  close_action=tray 关掉窗口后不退出，留在托盘后台运行

【书源怎么导入】
界面左侧「书源」→ 导入书源，三种方式都支持：
  1. 粘贴阅读（Legado）书源 JSON
  2. 填网络订阅地址
  3. 选择本地 .json 文件
新装的话，去 GitHub / 书源分享站复制一份书源包粘贴进去即可。

【出问题了看这里】
  · 运行日志：data\logs\server.log，托盘菜单里也能直接打开
  · 想看到实时输出：双击「调试模式.bat」，关掉窗口即停止服务
  · 浏览器没自动打开：手动访问 http://127.0.0.1:8080
  · 托盘图标不见了、但网页还能打开（例如用任务管理器结束过 书海.exe）：
    在任务管理器里结束 node.exe，再重新双击「书海.exe」
  · 杀毒软件/系统提示"未知发布者"：exe 没有数字签名，点"仍要运行"即可

【随包文件】
  书海.exe        启动器（托盘图标在这里）
  调试模式.bat    带命令行窗口的启动方式，排错用
  config.ini      配置
  app\            服务与网页源码（别删）
  runtime\        内置 Node 运行时（别删，目标电脑无需安装 Node）
  data\           你的书源与阅读数据

【运行前提】
  独立窗口用的是系统自带的 Microsoft Edge（Windows 10/11 都自带）；
  万一没有 Edge 又有 Chrome，会自动改用 Chrome；
  两个都没有才会退回默认浏览器开标签页，功能完全一样。
'@
[System.IO.File]::WriteAllText($readmePath, $readmeText, $utf8Bom)

$batPath = Join-Path $fullOut '调试模式.bat'
$batText = @'
@echo off
chcp 65001 >nul
title 书海 · 调试模式
cd /d "%~dp0app"
set "SHUHAI_HOST=127.0.0.1"
set "SHUHAI_PORT=8080"
set "SHUHAI_DB=%~dp0data\shuhai.db"
set "NODE_ENV=production"
if not exist "%~dp0data" mkdir "%~dp0data"
echo 正在启动书海，浏览器访问 http://127.0.0.1:8080
echo 关闭本窗口即停止服务。
echo.
"%~dp0runtime\node.exe" --disable-warning=ExperimentalWarning src\server.mjs
echo.
echo 服务已退出（退出码 %ERRORLEVEL%）。
pause
'@
# bat 必须是 UTF-8 无 BOM，否则 cmd.exe 会把 BOM 当成第一条命令
[System.IO.File]::WriteAllText($batPath, $batText, $utf8NoBom)

# ------------------------------------------------------------------ 汇总

$total = 0
Get-ChildItem -LiteralPath $fullOut -Recurse -File | ForEach-Object { $total += $_.Length }

Write-Host ''
Write-Host '打包完成' -ForegroundColor Green
Get-ChildItem -LiteralPath $fullOut | Select-Object Mode, @{n = 'Size'; e = { if ($_.PSIsContainer) { '<DIR>' } else { '{0:N0}' -f $_.Length } } }, Name |
    Format-Table -AutoSize | Out-String | Write-Host
Write-Host ("总大小: {0:N1} MB" -f ($total / 1MB))
Write-Host ''
Write-Host '直接双击 书海.exe 即可运行；把整个文件夹拷到别的 Windows 电脑也能跑（无需装 Node）。' -ForegroundColor Cyan
