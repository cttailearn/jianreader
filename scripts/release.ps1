<#
  简阅 发布脚本：构建安装包 → 计算 SHA-256 → 生成更新清单 latest.json → GitHub Release 发布指引

  更新机制：应用启动/手动检查时读取
    https://github.com/cttailearn/jianreader/releases/latest/download/latest.json
  清单中的 version / sha256 / url 决定是否下载安装新版本。

  用法：
    1) 先同步 bump 版本：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 三处 version
    2) 生成更新物料（首次自动构建；也可先构建后免 -Build 复用产物）：
         .\scripts\release.ps1 -Build -Notes "更新说明第一行`n- 修复了xxx"
    3) 发布到 GitHub：
         .\scripts\release.ps1 -Publish -Notes "..."   # 需已安装并登录 gh CLI（gh auth login）
       或按脚本末尾打印的手动命令用 Web 上传。

  常用参数：
    -Version  <string>  版本号，缺省读 tauri.conf.json
    -Notes    <string>  更新说明（写入 latest.json.notes，也用作 Release notes）
    -OutDir   <string>  输出目录（默认 .\release，已在 .gitignore）
    -Build              先执行 npm run tauri build
    -Publish            自动 gh release create + 上传资产
#>
param(
  [string]$Version = "",
  [string]$Notes = "",
  [string]$OutDir = "",
  [switch]$Build,
  [switch]$Publish
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot "release" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---------- 1. 确定版本 ----------
if (-not $Version) {
  $conf = Get-Content (Join-Path $repoRoot "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $Version = [string]$conf.version
}
if ($Version -notmatch '^\d+\.\d+') { throw "版本号格式不对：$Version（应为如 0.3.0），可用 -Version 指定" }
$tag = "v$Version"
Write-Host "==> 发布版本：$Version    tag：$tag"

# ---------- 2. 构建（可选） ----------
if ($Build) {
  Write-Host "==> 执行 npm run tauri build ..."
  Push-Location $repoRoot
  try { npm run tauri build } finally { Pop-Location }
}

# ---------- 3. 定位 NSIS 安装包（productName 命名，如 简阅_0.3.0_x64-setup.exe；须匹配当前版本，避免误选旧版残留） ----------
$nsisDir = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
$exe = Get-ChildItem -Path $nsisDir -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*_${Version}_x64-setup.exe" } |
  Select-Object -First 1
if (-not $exe) {
  throw "未找到匹配版本 v${Version} 的安装包：$nsisDir 下应存在 *_${Version}_x64-setup.exe（请先构建，或加上 -Build）"
}
# 资产统一用 ASCII 名，避免 GitHub URL 中文转义问题
$assetsName = "jianreader-setup_${Version}_x64-setup.exe"
$exeCopy = Join-Path $OutDir $assetsName
Copy-Item -LiteralPath $exe.FullName -Destination $exeCopy -Force
$sizeMb = [math]::Round($exe.Length / 1MB, 2)
Write-Host "==> 安装包：$($exe.Name)（${sizeMb} MB，另存为 $assetsName）"

# ---------- 4. 计算 SHA-256 ----------
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exeCopy).Hash.ToLower()
Write-Host "==> SHA-256：$hash"

# ---------- 5. 生成 latest.json ----------
$manifest = [ordered]@{
  version = [string]$Version
  url     = "https://github.com/cttailearn/jianreader/releases/latest/download/$assetsName"
  sha256  = $hash
  notes   = $Notes
}
$manifestPath = Join-Path $OutDir "latest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding utf8
Write-Host "==> 更新清单已生成：$manifestPath"

# ---------- 6. 发布 ----------
if ($Publish) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) { throw "未找到 gh CLI。请安装 https://cli.github.com 并执行 gh auth login，或用 Web 手动上传。" }
  Write-Host "==> gh release create $tag ..."
  gh release create $tag $exeCopy $manifestPath --repo cttailearn/jianreader --title "简阅 $Version" --notes $Notes
  if ($LASTEXITCODE -ne 0) { throw "gh release create 失败（exit $LASTEXITCODE）" }
  Write-Host "==> 已发布：https://github.com/cttailearn/jianreader/releases/tag/$tag"
} else {
  Write-Host ""
  Write-Host "==> 手动发布（二选一）："
  Write-Host "   A) 已登录 gh CLI 时执行："
  Write-Host "      gh release create $tag `"$exeCopy`" `"$manifestPath`" --repo cttailearn/jianreader --title `"简阅 $Version`" --notes `"$Notes`""
  Write-Host "   B) 网页：github.com/cttailearn/jianreader/releases/new"
  Write-Host "      - Tag：$tag    标题：简阅 $Version"
  Write-Host "      - 上传两个资产：$assetsName  和  latest.json"
  Write-Host "      - 发布后应用即可检查到更新（经 /releases/latest/download/ 访问 latest.json）"
}
