//! 简阅 —— Tauri 壳入口
//!
//! M1 骨架：窗口创建。
//! M2：fs 命令（编码检测读写/目录列举/文件操作）。
//! M3：watcher（目录监听）。

mod fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs::read_text_file,
            fs::write_text_file,
            fs::read_dir_entries,
            fs::create_file,
            fs::delete_path,
            fs::rename_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
