//! 轻量更新器（零新增依赖）：下载由前端 WebView 完成，此处只做
//!   1) 申请更新目录  2) base64 分块落盘  3) 触发静默安装并退出本进程

use tauri::{AppHandle, Manager};

/// RFC 4648 base64 解码（纯 std，供分块写入安装包用）
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() % 4 != 0 {
        return Err(format!("base64 长度非法: {}", compact.len()));
    }
    let mut vals = [0u8; 4];
    let mut out = Vec::with_capacity(compact.len() / 4 * 3);
    let chars: Vec<char> = compact.chars().collect();
    for chunk in chars.chunks(4) {
        for (i, c) in chunk.iter().enumerate() {
            vals[i] = match c {
                'A'..='Z' => *c as u8 - b'A',
                'a'..='z' => *c as u8 - b'a' + 26,
                '0'..='9' => *c as u8 - b'0' + 52,
                '+' => 62,
                '/' => 63,
                '=' => 0,
                other => return Err(format!("base64 字符非法: {other:?}")),
            };
        }
        let n = if chunk.len() == 4 { 4 } else { chunk.len() };
        out.push((vals[0] << 2) | (vals[1] >> 4));
        if n >= 3 && chunk[2] != '=' {
            out.push(((vals[1] & 0x0f) << 4) | (vals[2] >> 2));
        }
        if n == 4 && chunk[3] != '=' {
            out.push(((vals[2] & 0x03) << 6) | vals[3]);
        }
    }
    Ok(out)
}

/// RFC 4648 base64 编码（纯 std，PowerShell -EncodedCommand / git http.extraHeader 用）
pub(crate) fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(T[(n >> 6) as usize & 63] as char);
        out.push(T[n as usize & 63] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(T[(n >> 6) as usize & 63] as char);
        out.push('=');
    }
    out
}

fn utf16le(s: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(s.len() * 2);
    for u in s.encode_utf16() {
        v.extend_from_slice(&u.to_le_bytes());
    }
    v
}

/// 申请并创建更新目录：{app_local_data}/update，返回其路径
#[tauri::command]
pub async fn prepare_update_dir(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    let dir = base.join("update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 将 base64 块写入文件：append=false 时截断新建，true 时追加
#[tauri::command]
pub async fn write_update_chunk(path: String, b64: String, append: bool) -> Result<u64, String> {
    let bytes = b64_decode(&b64)?;
    if bytes.is_empty() {
        return Ok(0);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&path)
        .map_err(|e| format!("无法打开安装包临时文件: {e}"))?;
    let n = std::io::Write::write(&mut f, &bytes).map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// 计算文件 SHA-256（走系统 PowerShell，Windows 10+ 自带，零新增依赖）
#[tauri::command]
pub async fn sha256_file(path: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "(Get-FileHash -Algorithm SHA256 -LiteralPath '{}').Hash.ToLower()",
            path.replace('\'', "''")
        );
        let encoded = b64_encode(&utf16le(&script));
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
            .output()
            .map_err(|e| format!("计算校验和失败: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "计算校验和失败: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_lowercase());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("当前平台不支持计算 SHA-256".into())
    }
}

/// 静默安装：后台启动 <installer> /S，约 2s 后退出本进程
/// （安装器要替换正在运行的 exe，必须先让本进程退出释放占用）
#[tauri::command]
pub async fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let mut cmd = Command::new(&path);
        // /S 静默安装；CREATE_NO_WINDOW 避免弹出黑窗
        cmd.arg("/S").creation_flags(0x0800_0000);
        cmd.spawn().map_err(|e| format!("启动安装器失败: {e}"))?;
        // 等安装器完成初始化（解压自身、清理旧文件），随后退出本进程以释放 exe
        std::thread::sleep(std::time::Duration::from_millis(2200));
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, path);
        Err("当前仅支持在 Windows 上自动安装".into())
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

/// 拉取文本内容（更新清单 latest.json 用，Rust 侧无 CORS 限制）
#[tauri::command]
pub async fn download_text(url: String) -> Result<String, String> {
    let (out, _bin) = http_curl(&url, &[])?;
    String::from_utf8(out.stdout).map_err(|e| format!("响应不是 UTF-8: {e}"))
}

/// 下载文件到本地（安装包用）：curl -o dest，返回落盘字节数
fn download_file_impl(url: &str, dest: &str) -> Result<u64, String> {
    let (_out, _bin) = http_curl(url, &["-o", dest, "--create-dirs"])?;
    std::fs::metadata(dest)
        .map(|m| m.len())
        .map_err(|e| format!("下载完成但读取文件失败: {e}"))
}

#[tauri::command]
pub async fn download_file(url: String, dest: String) -> Result<u64, String> {
    download_file_impl(&url, &dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 联网冒烟测试（默认 #[ignore]，需手动运行：cargo test -- --ignored updater -- --nocapture）：
    // 验证 Rust curl 路径能拉取清单/下载安装包。默认打真实 GitHub；
    // 可用环境变量 JY_E2E_M_URL / JY_E2E_B_URL 重定向到本地 HTTP 服务器（沙箱 schannel 受限时用）。
    // 依赖网络与外部服务，CI/离线环境跳过。

    #[test]
    #[ignore]
    fn download_text_real_github() {
        let url = std::env::var("JY_E2E_M_URL").unwrap_or_else(|_| {
            "https://github.com/cttailearn/jianreader/releases/latest/download/latest.json"
                .to_string()
        });
        let (out, bin) = http_curl(&url, &[]).expect("curl 应能拉取清单");
        let body = String::from_utf8_lossy(&out.stdout);
        assert!(body.contains("0.3.0"), "清单应含版本号；实际: {}", &body[..body.len().min(160)]);
        eprintln!("[e2e] download_text OK via {bin}");
    }

    #[test]
    #[ignore]
    fn download_file_real_github() {
        let url = std::env::var("JY_E2E_B_URL").unwrap_or_else(|_| {
            "https://github.com/cttailearn/jianreader/releases/latest/download/jianreader-setup_0.3.0_x64-setup.exe"
                .to_string()
        });
        let dest_str = std::env::var("JY_E2E_DEST").unwrap_or_else(|_| {
            std::env::temp_dir()
                .join("jy-e2e-setup.exe")
                .to_string_lossy()
                .into_owned()
        });
        let bytes = download_file_impl(&url, &dest_str).expect("安装包应可下载");
        assert!(bytes == 4_427_554, "安装包大小应=4427554，实际 {bytes}");
        let _ = std::fs::remove_file(&dest_str);
        eprintln!("[e2e] download_file OK: {bytes} bytes");
    }

    #[test]
    fn b64_roundtrip() {
        let cases: [&[u8]; 5] = [
            b"",
            b"a",
            b"hello",
            b"Hello, \xe7\xae\x80\xe9\x98\x85!",
            &[0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f, 0x00],
        ];
        for c in cases {
            let enc = b64_encode(c);
            let dec = b64_decode(&enc).expect("decode ok");
            assert_eq!(dec, c, "roundtrip failed for {c:?}");
        }
    }

    #[test]
    fn b64_decode_known() {
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64_decode("YQ==").unwrap(), b"a");
        assert_eq!(b64_decode("aGVsbG8h").unwrap(), b"hello!");
    }

    #[test]
    fn b64_reject_bad() {
        assert!(b64_decode("ab").is_err()); // 长度不是 4 的倍数
        assert!(b64_decode("ab?_").is_err()); // 非法字符
    }
}
