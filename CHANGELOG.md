# 更新日志 Changelog

## 0.3.0 - 2026-08-31

### 新功能
- 新增「软件更新」：启动自动检查 + 设置面板手动检查 GitHub Releases 新版本（可在设置中关闭自动检查）
- 发现新版本后右下角横幅提示，一键下载（实时进度）→ SHA-256 双重校验 → 静默安装，重启后生效
- 更新源：GitHub Releases 的 `latest.json`（零新增后端依赖：前端 WebView 下载 + Rust 纯 std 落盘/校验/安装）
- 新增发布脚本 `scripts/release.ps1`：构建 → SHA-256 → 生成 `latest.json` → GitHub Release

### 其他
- 新增 CDP 调试脚本：`scripts/cdp_shot.js`（截图）、`scripts/cdp_monitor.js`（监听 + 轮询），与已有 `cdp_eval/cdp_console` 配套
- README：补充「软件更新」功能说明与「发布新版本」流程
