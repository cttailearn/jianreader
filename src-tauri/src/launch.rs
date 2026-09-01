//! 启动参数处理：文件关联"打开方式/默认程序"会把文件/目录路径作为 argv 传入，
//! 这里捕获并提供给前端，使双击文件时优先打开该文件而非恢复上次会话目录。

use std::path::Path;
use std::sync::OnceLock;

/// 进程启动参数（文件关联打开时含路径）
static LAUNCH_ARGS: OnceLock<Vec<String>> = OnceLock::new();

/// 记录启动参数（由 run() 调用）
pub fn capture() {
	let args: Vec<String> = std::env::args().skip(1).collect();
	let _ = LAUNCH_ARGS.set(args);
}

/// 从启动参数中返回第一个真实存在的路径（文件或目录；跳过空/以 - 开头的参数）；没有则 None
#[tauri::command]
pub fn get_launch_path() -> Result<Option<String>, String> {
	let args = LAUNCH_ARGS.get().cloned().unwrap_or_default();
	for a in args {
		let t = a.trim();
		if t.is_empty() || t.starts_with('-') {
			continue;
		}
		let p = Path::new(t);
		if p.exists() {
			return Ok(Some(t.to_string()));
		}
	}
	Ok(None)
}
