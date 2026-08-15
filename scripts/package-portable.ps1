# 打包绿色版（zip）：Tauri 无 zip target，Windows release 产物为单 exe，
# 直接压缩即为可拷走即用的绿色版（需系统自带 WebView2，Win10/11 默认具备）。
# 用法：先 npm run tauri build，再执行本脚本；产物输出到 release/
# 注意：脚本含中文注释，需 UTF-8 with BOM 保存（Windows PowerShell 5.1 兼容）

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "src-tauri\target\release"
# 兼容 mainBinaryName（简阅.exe）与 crate 名（text-viewer-editor.exe）
$exe = $null
foreach ($candidate in @("简阅.exe", "text-viewer-editor.exe")) {
    $p = Join-Path $releaseDir $candidate
    if (Test-Path $p) { $exe = $p; break }
}
if (-not $exe) {
    Write-Error "未找到 release 产物（简阅.exe / text-viewer-editor.exe），请先执行 npm run tauri build"
    exit 1
}
$outDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd"
$zip = Join-Path $outDir "简阅-绿色版-$stamp.zip"
# 临时目录里放单 exe + 使用说明，避免 zip 顶层带目录
$tmp = Join-Path $env:TEMP "jianyue-portable-$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item $exe (Join-Path $tmp "简阅.exe")
Copy-Item (Join-Path $root "scripts\绿色版说明.txt") (Join-Path $tmp "使用说明.txt")
Compress-Archive -Path (Join-Path $tmp "简阅.exe"), (Join-Path $tmp "使用说明.txt") -DestinationPath $zip -Force
Remove-Item -Recurse -Force $tmp
$sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "绿色版已生成：$zip（${sizeMB} MB）"
