//! 简阅 —— Tauri 壳入口
//!
//! M1 骨架：窗口创建。
//! M2：fs 命令（编码检测读写/目录列举/文件操作）。
//! M3：watcher（目录监听，notify → fs-event 推送）。
//! M6：启动自检（WebView2 缺失检测 + panic 诊断），绿色版闪退可定位。

mod fs;
mod novel;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_crash_reporting();
    if !check_webview2() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(watcher::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            fs::read_text_file,
            fs::write_text_file,
            fs::read_dir_entries,
            fs::create_file,
            fs::delete_path,
            fs::rename_path,
            watcher::start_watch,
            watcher::stop_watch,
            novel::scan_chapters,
            novel::read_chapter,
            novel::write_chapter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 崩溃诊断：panic → stderr + 日志文件 + 弹窗提示（否则 release 无声闪退无法定位）
fn setup_crash_reporting() {
    std::panic::set_hook(Box::new(|info| {
        // stderr：命令行重定向（2> panic.txt）可捕获
        eprintln!("[jianyue-panic] {info}");
        let mut log_note = String::new();
        for var in ["LOCALAPPDATA", "TEMP"] {
            if let Some(dir) = std::env::var_os(var) {
                let p = std::path::Path::new(&dir)
                    .join("com.jianreader.app")
                    .join("jianyue-crash.log");
                let line = format!(
                    "[{}] {}\n",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    info
                );
                let res = std::fs::create_dir_all(p.parent().unwrap_or(std::path::Path::new("")))
                    .and_then(|_| {
                        use std::io::Write;
                        std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&p)
                            .and_then(|mut f| f.write_all(line.as_bytes()))
                    });
                if let Err(e) = res {
                    log_note = format!("\n日志写入失败（{e}）：{}", p.display());
                } else {
                    log_note = format!("\n日志已写入：{}", p.display());
                    break;
                }
            }
        }
        let msg = format!("简阅发生内部错误（panic）：\n{info}{log_note}");
        #[cfg(target_os = "windows")]
        msgbox("简阅 - 意外退出", &msg);
    }));
}

/// WebView2 Runtime 存在性检测（绿色版拷到新机器时给出明确提示，而非闪退）
fn check_webview2() -> bool {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ];
    let found = candidates.iter().any(|d| {
        std::fs::read_dir(d)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false)
    });
    if !found {
        #[cfg(target_os = "windows")]
        msgbox(
            "简阅 - 缺少运行环境",
            "未检测到 Microsoft Edge WebView2 Runtime，无法启动。\n\n请安装 WebView2 Runtime（Windows 10/11 一般已自带）：\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
        );
    }
    found
}

/// Windows 消息框（裸 FFI，避免引入额外依赖）
#[cfg(target_os = "windows")]
fn msgbox(title: &str, text: &str) {
    extern "system" {
        fn MessageBoxW(
            hwnd: *const core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }
    let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let text_wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    // MB_OK | MB_ICONERROR | MB_TOPMOST
    unsafe {
        MessageBoxW(
            core::ptr::null(),
            text_wide.as_ptr(),
            title_wide.as_ptr(),
            0x10 | 0x40000,
        );
    }
}
