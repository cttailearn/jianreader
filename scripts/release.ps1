<#
  简阅 发布脚本：构建安装包 → GitHub Release 发布指引（附绿色版便携 zip）

  更新机制：应用启动/手动检查时调用 GitHub Releases API（releases/latest）比对新版本，
  有新版本则点击打开 Release 页手动下载安装；因此本脚本只需发布「安装包 + 绿色版」，
  不再生成/上传 latest.json 清单。

  用法：
    1) 先同步 bump 版本：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 三处 version
    2) 生成更新物料（首次自动构建；也可先构建后免 -Build 复用产物）：
         .\scripts\release.ps1 -Build -Notes "更新说明第一行`n- 修复了xxx"
    3) 发布到 GitHub：
         .\scripts\release.ps1 -Publish -Notes "..."   # 需已安装并登录 gh CLI（gh auth login）
       或按脚本末尾打印的手动命令用 Web 上传。

  常用参数：
    -Version  <string>  版本号，缺省读 tauri.conf.json
    -Notes    <string>  更新说明（写入 GitHub Release notes）
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

# ---------- 1b. 三处版本同步校验（R-27）：package.json / Cargo.toml / tauri.conf.json ----------
$pkgJson = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
if ([string]$pkgJson.version -ne [string]$Version) {
  throw "版本不一致：package.json=$($pkgJson.version)，tauri.conf.json=$Version。请先同步三处版本。"
}
$cargoToml = Get-Content (Join-Path $repoRoot "src-tauri\Cargo.toml") -Raw
# 正则匹配 Cargo.toml 的 version = "X.Y.Z"（仅 [package] 段）
$cargoVersionOk = $cargoToml -match "(?m)^version\s*=\s*`"$Version`""
if (-not $cargoVersionOk) {
  throw "版本不一致：src-tauri\Cargo.toml 未包含 version = `"$Version`"。请先同步三处版本。"
}
Write-Host "==> 三处版本一致：$Version"

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
$exeSize = (Get-Item -LiteralPath $exeCopy).Length
Write-Host "==> 安装包大小：$exeSize 字节"

# 更新机制（R-06，GitHub API 方案）：不再生成/上传 latest.json。
# 签名由 scripts/sign-release.mjs 写入 GitHub Release 备注（sig: <base64>），
# 客户端从 releases/latest API 读取并验签。此处在发布阶段（§6）执行。
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "未找到 node（发布时需要执行签名脚本 scripts/sign-release.mjs）" }
$sigKey = Join-Path $OutDir "update-key.json"
if (-not (Test-Path $sigKey)) {
  Write-Warning "未找到更新签名密钥（$sigKey），将自动生成。请把终端输出的公钥粘贴到 src/utils/updateVerify.ts 的 UPGRADE_PUBLIC_JWK。"
  pushd $repoRoot
  try { node scripts/update-key.mjs } finally { popd }
}

# ---------- 5. 绿色版（便携 zip，解压即用） ----------
pushd $repoRoot
try { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "package-portable.ps1") | Out-Null }
finally { popd }
$portableSrc = Get-ChildItem -Path $OutDir -Filter "简阅-绿色版-*.zip" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $portableSrc) { throw "绿色版打包失败：release/ 下未找到 简阅-绿色版-*.zip" }
$portableName = "jianreader-portable_${Version}_x64.zip"
$portableCopy = Join-Path $OutDir $portableName
Copy-Item $portableSrc.FullName $portableCopy -Force
$portableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $portableCopy).Hash.ToLower()
Write-Host "==> 绿色版：$portableName（SHA-256：$portableHash）"

# ---------- 6. 发布 ----------
if ($Publish) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) { throw "未找到 gh CLI。请安装 https://cli.github.com 并执行 gh auth login，或用 Web 手动上传。" }
  Write-Host "==> gh release create $tag ..."
  gh release create $tag $exeCopy $portableCopy --repo cttailearn/jianreader --title "简阅 $Version" --notes $Notes
  if ($LASTEXITCODE -ne 0) { throw "gh release create 失败（exit $LASTEXITCODE）" }
  # 签名写入 release 备注：客户端从此 API 读取并验签（无需 latest.json）
  $relJson = Join-Path $OutDir ".release-$tag.json"
  $relBody = gh api "repos/cttailearn/jianreader/releases/tags/$tag"
  if ($LASTEXITCODE -ne 0) { throw "gh api 读取 release 失败（exit $LASTEXITCODE）" }
  [System.IO.File]::WriteAllText($relJson, ($relBody -join "`n"), [System.Text.UTF8Encoding]::new($false))
  pushd $repoRoot
  try {
    $finalNotesLines = node scripts/sign-release.mjs --json $relJson --notes $Notes
  } finally { popd }
  if ($LASTEXITCODE -ne 0) { throw "sign-release 失败（exit $LASTEXITCODE）" }
  $finalNotes = ($finalNotesLines -join "`n")
  gh release edit $tag --repo cttailearn/jianreader --notes $finalNotes
  if ($LASTEXITCODE -ne 0) { throw "gh release edit（写入签名）失败（exit $LASTEXITCODE）" }
  Write-Host "==> 已发布：https://github.com/cttailearn/jianreader/releases/tag/$tag"
  Write-Host "    （签名已写入 release 备注：sig: <...>，客户端验签后可正常更新）"
} else {
  Write-Host ""
  Write-Host "==> 手动发布（二选一）："
  Write-Host "   A) 已登录 gh CLI 时执行（发布后自动把签名写入备注）："
  Write-Host "      gh release create $tag `"$exeCopy`" `"$portableCopy`" --repo cttailearn/jianreader --title `"简阅 $Version`" --notes `"$Notes`""
  Write-Host "      gh api repos/cttailearn/jianreader/releases/tags/$tag > release-info.json"
  Write-Host "      node scripts/sign-release.mjs --json release-info.json --notes `"$Notes`" > .final-notes.txt"
  Write-Host "      gh release edit $tag --repo cttailearn/jianreader --notes (Get-Content .final-notes.txt -Raw -Encoding UTF8)"
  Write-Host "   B) 网页：github.com/cttailearn/jianreader/releases/new"
  Write-Host "      - Tag：$tag    标题：简阅 $Version"
  Write-Host "      - 上传两个资产：$assetsName 和  $portableName（绿色版）"
  Write-Host "      - 发布后：gh api .../releases/tags/$tag > release-info.json；node scripts/sign-release.mjs --json release-info.json --notes `"$Notes`" > .final-notes.txt；gh release edit $tag --notes (Get-Content .final-notes.txt -Raw -Encoding UTF8)"
}
