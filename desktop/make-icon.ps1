<#
  生成「书海」桌面版图标（多尺寸 .ico）。

  纯 System.Drawing 手绘，不依赖任何设计资源：蓝色渐变圆角方块 + 白色书本。
  只写 32bpp 的 DIB 条目（不用 PNG 压缩条目），因为 System.Drawing.Icon
  对 PNG 压缩的 ICO 支持不稳，托盘图标会挂。
#>

param(
    [string]$Out = (Join-Path $PSScriptRoot 'app.ico'),
    [string]$PreviewPng = (Join-Path $PSScriptRoot 'app-preview.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedPath {
    param([double]$X, [double]$Y, [double]$W, [double]$H, [double]$R)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    if ($R -lt 0.5) { $R = 0.5 }
    $d = $R * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # —— 底：圆角方块，蓝色渐变（对应网页里的 --ui-primary #2f6fed）——
    $bg = New-RoundedPath 0 0 $Size $Size ($Size * 0.225)
    $c1 = [System.Drawing.Color]::FromArgb(255, 79, 145, 255)
    $c2 = [System.Drawing.Color]::FromArgb(255, 30, 84, 190)
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point($Size, $Size)), $c1, $c2)
    $g.FillPath($bgBrush, $bg)

    # —— 白色书本 ——
    $bx = $Size * 0.255
    $by = $Size * 0.205
    $bw = $Size * 0.49
    $bh = $Size * 0.59
    $book = New-RoundedPath $bx $by $bw $bh ($Size * 0.08)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.FillPath($white, $book)

    # —— 书脊：一条细蓝竖线 ——
    $spineW = [Math]::Max(1.0, $Size * 0.078)
    $spine = New-RoundedPath ($bx + $bw * 0.15) ($by + $bh * 0.06) $spineW ($bh * 0.88) ($spineW / 2)
    $spineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 47, 111, 237))
    $g.FillPath($spineBrush, $spine)

    $spine.Dispose(); $book.Dispose(); $bg.Dispose()
    $bgBrush.Dispose(); $white.Dispose(); $spineBrush.Dispose()
    $g.Dispose()
    return $bmp
}

function Get-DibBytes {
    param([System.Drawing.Bitmap]$Bmp)

    $w = $Bmp.Width
    $h = $Bmp.Height
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)

    # BITMAPINFOHEADER：高度写两倍（XOR + AND 两张图）
    $bw.Write([int]40)
    $bw.Write([int]$w)
    $bw.Write([int]($h * 2))
    $bw.Write([Int16]1)
    $bw.Write([Int16]32)
    $bw.Write([int]0)
    $bw.Write([int]($w * $h * 4))
    $bw.Write([int]0)
    $bw.Write([int]0)
    $bw.Write([int]0)
    $bw.Write([int]0)

    # 像素：32bpp BGRA，自下而上
    for ($y = $h - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $w; $x++) {
            $c = $Bmp.GetPixel($x, $y)
            $bw.Write([byte]$c.B)
            $bw.Write([byte]$c.G)
            $bw.Write([byte]$c.R)
            $bw.Write([byte]$c.A)
        }
    }

    # AND 掩码：32bpp 走 alpha 通道，全部置 0 即可，行按 4 字节对齐
    $maskRow = [int]([Math]::Ceiling($w / 32.0) * 4)
    $zero = New-Object 'byte[]' $maskRow
    for ($y = 0; $y -lt $h; $y++) { $bw.Write($zero) }

    $bw.Flush()
    $bytes = $ms.ToArray()
    $bw.Dispose()
    $ms.Dispose()
    # 注意这个逗号：不加的话 PowerShell 会把 byte[] 拆成 object[] 丢进管道，
    # 后面 BinaryWriter.Write 就会选错重载，只写出 1 个字节
    return , $bytes
}

# ------------------------------------------------------------------ 组装 ICO

$sizes = @(16, 24, 32, 48, 64, 128)
$entries = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $data = Get-DibBytes $bmp
    $bmp.Dispose()
    $entries += [pscustomobject]@{ Size = $s; Data = $data }
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)              # reserved
$bw.Write([UInt16]1)              # type = icon
$bw.Write([UInt16]$entries.Count) # count

$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = $e.Size
    if ($dim -ge 256) { $dim = 0 }
    $bw.Write([byte]$dim)         # width
    $bw.Write([byte]$dim)         # height
    $bw.Write([byte]0)            # palette
    $bw.Write([byte]0)            # reserved
    $bw.Write([UInt16]1)          # planes
    $bw.Write([UInt16]32)         # bpp
    $bw.Write([UInt32]$e.Data.Length)
    $bw.Write([UInt32]$offset)
    $offset += $e.Data.Length
}
foreach ($e in $entries) { $bw.Write([byte[]]$e.Data) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($Out, $ms.ToArray())
$bw.Dispose()
$ms.Dispose()

# ------------------------------------------------------------------ 自检

# 写得出来不代表读得回去；System.Drawing 认不出来的 ICO，csc 的 /win32icon 也会翻脸
$check = New-Object System.Drawing.Icon($Out)
$check.Dispose()

# ------------------------------------------------------------------ 预览图

$preview = New-IconBitmap 256
$preview.Save($PreviewPng, [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()

Write-Output ("icon -> {0} ({1} bytes, {2} sizes)" -f $Out, (Get-Item $Out).Length, $entries.Count)
Write-Output ("preview -> {0}" -f $PreviewPng)
