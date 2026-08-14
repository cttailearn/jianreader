//! 简阅 —— Tauri 壳入口
//!
//! M1 骨架：仅创建窗口。
//! M2+ 在此注册 fs 命令（读文件/编码检测/写文件）、watcher（目录监听）。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
