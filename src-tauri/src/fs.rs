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

/// GBK 序列合法性检测：头部 64KB 中，单字节 ASCII + 合法双字节对（前导 0x81-0xFE + 续 0x40-0xFE）
/// 占比 ≥95% 视为"像 GBK"。用于 chardetng 误判拉丁系编码时的兜底（M8：中文 txt 乱码修复）。
fn gbk_plausible(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(65536)];
    if head.is_empty() {
        return false;
    }
    let mut ok = 0usize;
    let mut total = 0usize;
    let mut i = 0usize;
    while i < head.len() {
        let b = head[i];
        if b < 0x80 {
            ok += 1;
            total += 1;
            i += 1;
            continue;
        }
        if (0x81..=0xFE).contains(&b) && i + 1 < head.len() {
            let c = head[i + 1];
            if (0x40..=0xFE).contains(&c) && c != 0x7F {
                ok += 1;
            }
            total += 1;
            i += 2;
            continue;
        }
        total += 1;
        i += 1;
    }
    let dbl = head.len() - head.iter().filter(|&&b| b < 0x80).count();
    total > 0 && dbl >= 8 && ok * 100 / total >= 95
}

/// chardetng 结果是否属于中文/多字节编码（拉丁系结果需要 GBK 兜底校验）
fn is_cjk_encoding(name: &str) -> bool {
    matches!(
        name,
        "GBK" | "GB18030" | "GB2312" | "Big5" | "EUC-KR" | "EUC-JP" | "Shift_JIS" | "UTF-16"
            | "UTF-16LE"
            | "UTF-16BE" | "windows-949" | "ISO-2022-JP" | "ISO-2022-KR"
    ) || name.starts_with("UTF-16")
}

/// 编码检测（BOM 优先 → UTF-8 校验 → UTF-16 无 BOM 启发 → chardetng + GBK 兜底）。
/// 返回 (编码显示名, has_bom)，供 fs/novel 共用。
pub fn detect_encoding(bytes: &[u8]) -> (String, bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return ("UTF-8 BOM".into(), true);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return ("UTF-16 LE".into(), true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return ("UTF-16 BE".into(), true);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return ("UTF-8".into(), false);
    }
    // UTF-16 无 BOM 启发：按 2 字节分组时，高位字节 ∈ {0x00(ASCII)} ∪ {0x4E-0x9F(汉字)} ∪ {0xFF(全角标点)}
    let head = &bytes[..bytes.len().min(4096)];
    if head.len() >= 64 {
        let half = head.len() / 2;
        let odd_candidate = head
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|&&b| b == 0 || (0x4E..=0x9F).contains(&b) || b == 0xFF)
            .count();
        let even_candidate = head
            .iter()
            .step_by(2)
            .filter(|&&b| b == 0 || (0x4E..=0x9F).contains(&b) || b == 0xFF)
            .count();
        if odd_candidate > half * 85 / 100 {
            return ("UTF-16 LE".into(), false);
        }
        if even_candidate > half * 85 / 100 {
            return ("UTF-16 BE".into(), false);
        }
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let name = enc.name().to_owned();
    // chardetng 误判拉丁系时，若字节序列高度符合 GBK → 兜底判定 GBK
    if !is_cjk_encoding(&name) && gbk_plausible(bytes) {
        return ("GBK".into(), false);
    }
    (name, false)
}

/// 检测并解码文本（不抛错，乱码场景用 lossy 兜底）
fn decode_text(bytes: &[u8]) -> (String, String, bool) {
    let (encoding, has_bom) = detect_encoding(bytes);
    let s = match encoding.as_str() {
        "UTF-8" => String::from_utf8_lossy(bytes).into_owned(),
        "UTF-8 BOM" => String::from_utf8_lossy(&bytes[3..]).into_owned(),
        "UTF-16 LE" => {
            let start = if has_bom { 2 } else { 0 };
            encoding_rs::UTF_16LE.decode(&bytes[start..]).0.into_owned()
        }
        "UTF-16 BE" => {
            let start = if has_bom { 2 } else { 0 };
            encoding_rs::UTF_16BE.decode(&bytes[start..]).0.into_owned()
        }
        label => {
            let enc = encoding_rs::Encoding::for_label(norm_label(label).as_bytes())
                .unwrap_or(encoding_rs::UTF_8);
            enc.decode(bytes).0.into_owned()
        }
    };
    (s, encoding, has_bom)
}

/// 编码 label 规范化（显示名 "UTF-16 LE"/"UTF-8 BOM" → encoding_rs 标准 label）
fn norm_label<'a>(label: &'a str) -> &'a str {
    match label {
        "UTF-16 LE" => "UTF-16LE",
        "UTF-16 BE" => "UTF-16BE",
        "UTF-8 BOM" => "UTF-8",
        other => other,
    }
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
/// show_hidden=true 时显示 .git/node_modules 等隐藏项（设置开关，M9）
#[tauri::command]
pub fn read_dir_entries(path: String, show_hidden: Option<bool>) -> Result<Vec<DirEntryInfo>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let rd = fs::read_dir(&path).map_err(|e| io_err(e, "读取目录"))?;
    let mut dirs: Vec<DirEntryInfo> = Vec::new();
    let mut files: Vec<DirEntryInfo> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !show_hidden {
            if is_dir && NOISE_DIRS.contains(&name.as_str()) {
                continue;
            }
            if name.starts_with('.') {
                continue; // 隐藏文件/目录（. 开头）
            }
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
