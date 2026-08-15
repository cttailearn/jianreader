//! 文件读写命令：编码检测、原编码回写、目录列举
//!
//! 编码检测链路：BOM → UTF-8 严格校验 → chardetng 猜测 → encoding_rs 解码
//! 保存链路：按打开时的编码 + 原 EOL 回写，保证外部工具看到的字节风格不变

use serde::Serialize;
use std::fs;
use std::path::Path;

/// 读文件返回体
#[derive(Serialize)]
pub struct FilePayload {
    pub content: String,
    pub encoding: String, // "UTF-8" / "UTF-8 BOM" / "GBK" / "Big5" / "UTF-16 LE" ...
    pub has_bom: bool,
    pub eol: String, // "\r\n" 或 "\n"（按多数行判定）
    pub size: u64,
    /// 磁盘只读属性（Windows readonly 位），前端禁止编辑
    pub readonly: bool,
}

/// 目录条目
#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 目录树默认忽略的噪音目录（P0 决策）
const NOISE_DIRS: [&str; 5] = [".git", "node_modules", "dist", ".svn", ".hg"];

fn io_err(e: std::io::Error, action: &str) -> String {
    format!("{action}失败: {e}")
}

/// 检测并解码文本（不抛错，乱码场景用 lossy 兜底）
fn decode_text(bytes: &[u8]) -> (String, String, bool) {
    // 1) BOM 优先
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (
            String::from_utf8_lossy(&bytes[3..]).into_owned(),
            "UTF-8 BOM".into(),
            true,
        );
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (s.into_owned(), "UTF-16 LE".into(), true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return (s.into_owned(), "UTF-16 BE".into(), true);
    }
    // 2) UTF-8 严格校验（SIMD 快速路径，覆盖绝大多数现代文件）
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_owned(), "UTF-8".into(), false);
    }
    // 3) chardetng 猜测 + encoding_rs 解码（GBK/Big5/Shift_JIS...）
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (s, _, _) = enc.decode(bytes);
    (s.into_owned(), enc.name().to_owned(), false)
}

/// 按原编码编码回写（含 BOM 还原）
fn encode_text(text: &str, encoding: &str, has_bom: bool) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::with_capacity(text.len() + 3);
    match encoding {
        "UTF-8" | "UTF-8 BOM" => {
            if has_bom || encoding == "UTF-8 BOM" {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        "UTF-16 LE" => {
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        "UTF-16 BE" => {
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            Ok(out)
        }
        label => {
            let enc = encoding_rs::Encoding::for_label(label.as_bytes())
                .ok_or_else(|| format!("不支持的编码: {label}"))?;
            let (bytes, _, had_errors) = enc.encode(text);
            if had_errors {
                return Err(format!("文本包含 {label} 无法表示的字符，保存被取消"));
            }
            out.extend_from_slice(&bytes);
            Ok(out)
        }
    }
}

/// 按目标 EOL 规范化换行符（编辑器内部统一 LF，保存时还原；novel.rs 写回也复用）
pub fn normalize_eol(text: &str, eol: &str) -> String {
    if eol != "\r\n" {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len() + text.len() / 40);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            out.push_str("\r\n");
        } else if c == '\r' {
            // 编辑器里残留的 \r\n 已是 CRLF，直接保留
            out.push('\r');
            if chars.peek() == Some(&'\n') {
                out.push('\n');
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 从内容统计主导 EOL
fn detect_eol(text: &str) -> String {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf {
        "\r\n".to_owned()
    } else {
        "\n".to_owned()
    }
}

/// 读取文本文件：编码检测 + 解码
#[tauri::command]
pub fn read_text_file(path: String) -> Result<FilePayload, String> {
    let bytes = fs::read(&path).map_err(|e| io_err(e, "读取文件"))?;
    let size = bytes.len() as u64;
    let readonly = fs::metadata(&path)
        .map(|m| m.permissions().readonly())
        .unwrap_or(false);
    let (content, encoding, has_bom) = decode_text(&bytes);
    let eol = detect_eol(&content);
    Ok(FilePayload {
        content,
        encoding,
        has_bom,
        eol,
        size,
        readonly,
    })
}

/// 写文本文件：原编码 + 原 EOL 回写；成功后登记回环抑制白名单，返回新文件大小
#[tauri::command]
pub fn write_text_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
    encoding: String,
    has_bom: bool,
    eol: String,
) -> Result<u64, String> {
    let normalized = normalize_eol(&content, &eol);
    let bytes = encode_text(&normalized, &encoding, has_bom)?;
    fs::write(&path, &bytes).map_err(|e| io_err(e, "写入文件"))?;
    crate::watcher::register_saved(&app, &path);
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| io_err(e, "获取文件信息"))
}

/// 路径类型判定（拖拽打开分发用）：目录 true / 文件 false；不存在报错
#[tauri::command]
pub fn path_is_dir(path: String) -> Result<bool, String> {
    fs::metadata(&path)
        .map(|m| m.is_dir())
        .map_err(|e| io_err(e, "读取路径"))
}

/// 文件元信息（图片查看/大文件标签用）：大小 + 只读属性
#[tauri::command]
pub fn file_meta(path: String) -> Result<(u64, bool), String> {
    let meta = fs::metadata(&path).map_err(|e| io_err(e, "读取文件信息"))?;
    Ok((meta.len(), meta.permissions().readonly()))
}

/// 列举一层目录（懒加载），目录在前按名排序，过滤噪音目录
#[tauri::command]
pub fn read_dir_entries(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let rd = fs::read_dir(&path).map_err(|e| io_err(e, "读取目录"))?;
    let mut dirs: Vec<DirEntryInfo> = Vec::new();
    let mut files: Vec<DirEntryInfo> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && NOISE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let size = if is_dir {
            0
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        let p = entry.path().to_string_lossy().into_owned();
        let info = DirEntryInfo {
            name,
            path: p,
            is_dir,
            size,
        };
        if is_dir {
            dirs.push(info);
        } else {
            files.push(info);
        }
    }
    dirs.sort_by_key(|a| a.name.to_lowercase());
    files.sort_by_key(|a| a.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

/// 创建文件/文件夹（右键菜单用）
#[tauri::command]
pub fn create_file(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        fs::create_dir(&path).map_err(|e| io_err(e, "创建文件夹"))
    } else {
        if Path::new(&path).exists() {
            return Err("文件已存在".into());
        }
        fs::write(&path, b"").map_err(|e| io_err(e, "创建文件"))
    }
}

/// 删除到回收站（Windows 直接删或走回收站；当前实现为永久删除，M3 换 trash crate）
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| io_err(e, "删除目录"))
    } else {
        fs::remove_file(p).map_err(|e| io_err(e, "删除文件"))
    }
}

/// 重命名
#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<(), String> {
    let p = Path::new(&path);
    let parent = p.parent().ok_or("无法确定父目录")?;
    let target = parent.join(&new_name);
    if target.exists() {
        return Err("同名文件/目录已存在".into());
    }
    fs::rename(p, &target).map_err(|e| io_err(e, "重命名"))
}
