//! 轻量更新器（零新增依赖）：
//!   提供 `download_text`，用本机 curl 无 CORS 拉取文本（GitHub Releases API）。
//!   前端据此检查新版本；安装改为「点击打开 Release 页手动下载」，不再做应用内下载/静默安装。

/// Windows 下给子进程加 CREATE_NO_WINDOW，避免 curl.exe 之类的控制台程序
/// 在应用运行时弹出黑窗（影响体验）；非 Windows 为空操作
fn no_window(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// Windows 下可用的 curl 候选（按优先级）：
/// 系统自带 curl（schannel，正常机器可用）→ 各盘符 Git for Windows 内置 curl → PATH 兜底。
/// （本沙箱因 schannel 不可用所有 curl 均无法 HTTPS，仅本地 HTTP 可测；真实机器无此问题）
fn curl_candidates() -> Vec<std::path::PathBuf> {
    let mut v = vec![std::path::PathBuf::from(r"C:\Windows\System32\curl.exe")];
    // Git for Windows 常见安装路径（多盘符）
    for d in ["C", "D", "E", "F", "G"] {
        v.push(std::path::PathBuf::from(format!(
            "{d}:\\Program Files\\Git\\mingw64\\bin\\curl.exe"
        )));
        v.push(std::path::PathBuf::from(format!(
            "{d}:\\Program Files (x86)\\Git\\mingw64\\bin\\curl.exe"
        )));
    }
    // PATH 兜底
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(';') {
            if dir.is_empty() {
                continue;
            }
            let p = std::path::Path::new(dir).join("curl.exe");
            if p.exists() && !v.contains(&p) {
                v.push(p);
            }
        }
    }
    v.into_iter().filter(|p| p.exists()).collect()
}

/// 用 curl 抓取 URL；依次尝试各候选 curl，首个成功即返回；全失败返回最后一条错误
fn http_curl(url: &str, extra_args: &[&str]) -> Result<(std::process::Output, String), String> {
    let candidates = curl_candidates();
    if candidates.is_empty() {
        return Err("未找到 curl.exe（需 Windows 10 1803+ 自带或已安装 Git）".into());
    }
    let mut last_err = String::new();
    for bin in candidates {
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(["-fsSL", "--retry", "2", "--connect-timeout", "15"]);
        cmd.args(extra_args);
        cmd.arg(url);
        no_window(&mut cmd);
        match cmd.output() {
            Ok(o) => {
                if o.status.success() {
                    return Ok((o, bin.display().to_string()));
                }
                last_err = format!(
                    "curl({}) 失败: {}",
                    bin.display(),
                    String::from_utf8_lossy(&o.stderr).trim()
                );
            }
            Err(e) => last_err = format!("curl({}) 无法启动: {}", bin.display(), e),
        }
    }
    Err(last_err)
}

/// 拉取文本内容（GitHub Releases API 用，Rust 侧无 CORS 限制）
#[tauri::command]
pub async fn download_text(url: String) -> Result<String, String> {
    let (out, _bin) = http_curl(&url, &[])?;
    String::from_utf8(out.stdout).map_err(|e| format!("响应不是 UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 联网冒烟测试（默认 #[ignore]，需手动运行：cargo test -- --ignored updater）：
    // 验证 Rust curl 路径能拉取 GitHub Releases API。默认打真实 GitHub；
    // 可用环境变量 JY_E2E_M_URL 重定向到本地 HTTP 服务器（沙箱 schannel 受限时用）。
    // 依赖网络与外部服务，CI/离线环境跳过。

    #[test]
    #[ignore]
    fn download_text_real_github() {
        let url = std::env::var("JY_E2E_M_URL").unwrap_or_else(|_| {
            "https://api.github.com/repos/cttailearn/jianreader/releases/latest".to_string()
        });
        let (out, bin) = http_curl(&url, &[]).expect("curl 应能拉取 Releases API");
        let body = String::from_utf8_lossy(&out.stdout);
        assert!(
            body.contains("\"tag_name\""),
            "响应应为 GitHub Releases JSON；实际: {}",
            &body[..body.len().min(160)]
        );
        eprintln!("[e2e] download_text OK via {bin}");
    }
}
