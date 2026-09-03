//! 文件读写命令：编码检测、原编码写回、目录列举
//!
//! 编码检测链路：BOM → UTF-8 严格校验 → 无 BOM UTF-16 启发 → chardetng 猜测 → GBK 兜底
//! 保存链路：按打开时的编码 + 原 EOL 回写，保证外部工具看到的字节风格不变
//!
//! 安全（R-05/R-07）：所有「内容读 / 写 / 删 / 改名」按用户显式打开的路径作用域校验
//! （fs_scope_allow 登记），未登记路径拒绝操作，缩小 WebView 被攻破后的影响面。
//! 删除默认进回收站（SHFileOperationW + FOF_ALLOWUNDO），不再永久删除。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

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
    /// 大文件标记：>8MB 时前端提示内存占用（R-17）
    pub large: bool,
}

/// 目录条目
#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 目录树默认忽略的噪音目录
const NOISE_DIRS: [&str; 5] = [".git", "node_modules", "dist", ".svn", ".hg"];

/// 大文件标记阈值：超过则 large=true（前端提示）
pub const LARGE_MARK: u64 = 8 * 1024 * 1024;
/// 硬上限：超过则拒绝整读（防超大文件 OOM；>96MB）
pub const LARGE_HARD: u64 = 96 * 1024 * 1024;
/// 目录展开时 per-file metadata 的条目上限（超过则跳过取大小，省句柄，R-25）
const META_THRESHOLD: usize = 2000;

/// 用户显式打开的路径作用域：(目录, 是否递归)。文件树根目录登记为递归，
/// 单文件拖拽/打开登记其父目录（非递归）。
#[derive(Default)]
pub struct FsScope {
    allowed: Mutex<Vec<(PathBuf, bool)>>,
}

impl FsScope {
    pub fn allow(&self, dir: impl Into<PathBuf>, recursive: bool) {
        let d = dir.into();
        let mut g = self.allowed.lock().unwrap_or_else(|e| e.into_inner());
        if !g.iter().any(|(x, r)| *x == d && *r == recursive) {
            g.push((d, recursive));
        }
    }

    /// path 是否在已登记作用域内（Windows 大小写不敏感，含边界字符判断）
    pub fn is_allowed(&self, path: &str) -> bool {
        let norm = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let pn = norm(Path::new(path));
        let pn = pn.trim_end_matches('\\').to_string();
        let pn_l = pn.to_lowercase();
        let g = self.allowed.lock().unwrap_or_else(|e| e.into_inner());
        g.iter().any(|(d, rec)| {
            let dn = norm(d);
            let dn = dn.trim_end_matches('\\').to_string();
            if *rec {
                // 递归：path == dir 或 dir 的子路径（前一个字符为分隔符）
                let rest = pn_l.strip_prefix(&dn.to_lowercase());
                match rest {
                    Some("") => true,
                    Some(r) => r.starts_with('\\'),
                    None => false,
                }
            } else {
                // 非递归：path == dir，或 path 的直接子项
                if pn_l == dn.to_lowercase() {
                    return true;
                }
                match Path::new(&pn).parent() {
                    Some(parent) => {
                        let pl = parent.to_string_lossy().replace('/', "\\");
                        let pl = pl.trim_end_matches('\\').to_lowercase();
                        pl == dn.to_lowercase()
                    }
                    None => false,
                }
            }
        })
    }
}

/// 内容读/写/删/改名前的作用域校验
pub fn scope_allowed(app: &AppHandle, path: &str) -> bool {
    match app.try_state::<FsScope>() {
        Some(s) => s.is_allowed(path),
        None => true, // 状态未初始化（理论不发生）时放行，避免锁死
    }
}

fn io_err(e: std::io::Error, action: &str) -> String {
    format!("{action}失败: {e}")
}

/// GBK 序列合法性检测：头部 64KB 中，单字节 ASCII + 合法双字节对（前导 0x81-0xFE + 续 0x40-0xFE）
/// 占比 ≥95% 视为"像 GBK"。用于 chardetng 误判拉丁系编码时的兜底。
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
    // UTF-16 无 BOM 启发：按 2 字节分组时，高位字节 ∈ {0x00(ASCII)} ∪ {0x4E-0x9F(汉字)} ∪ {0xFF}
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
    if !is_cjk_encoding(&name) && gbk_plausible(bytes) {
        return ("GBK".into(), false);
    }
    (name, false)
}

/// 编码 label 规范化（显示名 → encoding_rs 标准 label）
fn norm_label(label: &str) -> &str {
    match label {
        "UTF-16 LE" => "UTF-16LE",
        "UTF-16 BE" => "UTF-16BE",
        "UTF-8 BOM" => "UTF-8",
        other => other,
    }
}

/// 检测并解码文本（不抛错，乱码场景用 lossy 兜底）
fn decode_text(bytes: &[u8]) -> (String, String, bool) {
    let (encoding, has_bom) = detect_encoding(bytes);
    let s = decode_with(bytes, &encoding, has_bom);
    (s, encoding, has_bom)
}

/// 按指定编码 + BOM 标志解码（供 override 路径复用同一套逻辑）
fn decode_with(bytes: &[u8], encoding: &str, has_bom: bool) -> String {
    match encoding {
        "UTF-8" => {
            let b = if has_bom && bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                &bytes[3..]
            } else {
                bytes
            };
            String::from_utf8_lossy(b).into_owned()
        }
        "UTF-8 BOM" => String::from_utf8_lossy(&bytes[3.min(bytes.len())..]).into_owned(),
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
    }
}

/// 按原编码编码回写（含 BOM 还原；UTF-16 仅当原文件有 BOM 才写 BOM，R-10）
pub fn encode_text(text: &str, encoding: &str, has_bom: bool) -> Result<Vec<u8>, String> {
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
            if has_bom {
                out.extend_from_slice(&[0xFF, 0xFE]);
            }
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        "UTF-16 BE" => {
            if has_bom {
                out.extend_from_slice(&[0xFE, 0xFF]);
            }
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

/// 原子写：同目录临时文件 + rename 覆盖（Windows 同卷 rename 为原子替换，R-16b）
pub fn atomic_write(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    let p = Path::new(path);
    let parent = p.parent().unwrap_or(Path::new(""));
    let name = p.file_name().unwrap_or_default();
    let tmp = parent.join(format!(".{}.tmp{}", name.to_string_lossy(), std::process::id()));
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, p) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
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

/// 登记一个已打开的路径作用域（前端 openRoot/openFile 时调用，R-05/R-07）
#[tauri::command]
pub fn fs_scope_allow(app: AppHandle, path: String, recursive: bool) -> Result<(), String> {
    let state = app.state::<FsScope>();
    state.allow(PathBuf::from(&path), recursive);
    // 顺带放行 asset 协议读该目录（图片渲染），Tauri 2 的 asset scope 动态注册
    #[cfg(desktop)]
    {
        let scope = app.asset_protocol_scope();
        let d = &path;
        if recursive {
            let _ = scope.allow_directory(d, true);
        } else {
            // 非递归目录：仅放行直接子项（读取 + 显示），allow_directory 会覆盖子树，
            // 这里用 allow_file_for ... 不好表达，退化为允许该目录递归读（内容受 scope_allowed 制约）
            let _ = scope.allow_directory(d, true);
        }
    }
    Ok(())
}

/// 读取文本文件：编码检测 + 解码；可携带检测覆盖（小说扫描复用，R-21）
#[tauri::command]
pub fn read_text_file(
    app: AppHandle,
    path: String,
    encoding_override: Option<String>,
    has_bom_override: Option<bool>,
) -> Result<FilePayload, String> {
    if !scope_allowed(&app, &path) {
        return Err("无权访问该路径（不在已打开的目录内）".into());
    }
    let meta = fs::metadata(&path).map_err(|e| io_err(e, "读取文件"))?;
    let size = meta.len();
    if size > LARGE_HARD {
        return Err(format!(
            "文件过大（{:.1} MB），为避免内存占用已拒绝整读。\n建议：txt 请用「以阅读模式打开」分章阅读；其它大文件请用编辑器拆分或截取。",
            size as f64 / 1_000_000f64
        ));
    }
    let bytes = fs::read(&path).map_err(|e| io_err(e, "读取文件"))?;
    let readonly = meta.permissions().readonly();
    let (content, encoding, has_bom) = match (encoding_override, has_bom_override) {
        (Some(enc), ob) => {
            let hb = ob.unwrap_or(false);
            let eff = if enc == "UTF-8" && hb { "UTF-8 BOM" } else { enc.as_str() }.to_string();
            let s = decode_with(&bytes, &eff, hb);
            (s, eff, hb)
        }
        _ => decode_text(&bytes),
    };
    let eol = detect_eol(&content);
    Ok(FilePayload {
        content,
        encoding,
        has_bom,
        eol,
        size,
        readonly,
        large: size > LARGE_MARK,
    })
}

/// 写文本文件：原编码 + 原 EOL 回写（原子写）；成功后登记回环抑制白名单
#[tauri::command]
pub fn write_text_file(
    app: AppHandle,
    path: String,
    content: String,
    encoding: String,
    has_bom: bool,
    eol: String,
) -> Result<u64, String> {
    if !scope_allowed(&app, &path) {
        return Err("无权写入该路径（不在已打开的目录内）".into());
    }
    let normalized = normalize_eol(&content, &eol);
    let bytes = encode_text(&normalized, &encoding, has_bom)?;
    atomic_write(&path, &bytes).map_err(|e| io_err(e, "写入文件"))?;
    crate::watcher::register_saved(&app, &path);
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| io_err(e, "获取文件信息"))
}

/// 路径类型判定（拖拽打开分发用）：目录 true / 文件 false；不存在报错
/// 仅元信息，不做作用域限制（拖入目录前尚未登记）
#[tauri::command]
pub fn path_is_dir(path: String) -> Result<bool, String> {
    fs::metadata(&path)
        .map(|m| m.is_dir())
        .map_err(|e| io_err(e, "读取路径"))
}

/// 文件元信息（图片查看/更新下载进度用）：大小 + 只读属性
#[tauri::command]
pub fn file_meta(app: AppHandle, path: String) -> Result<(u64, bool), String> {
    // 更新目录已登记递归作用域；图片文件已在作用域内。未登记时仍只给元信息（低风险）。
    if !scope_allowed(&app, &path) {
        // 元信息泄露面极小，但为一致起见返回错误
        return Err("无权访问该路径".into());
    }
    let meta = fs::metadata(&path).map_err(|e| io_err(e, "读取文件信息"))?;
    Ok((meta.len(), meta.permissions().readonly()))
}

/// 列举一层目录（懒加载），目录在前按名排序，过滤噪音目录（R-23 与 R-25）
#[tauri::command]
pub fn read_dir_entries(
    app: AppHandle,
    path: String,
    show_hidden: Option<bool>,
) -> Result<Vec<DirEntryInfo>, String> {
    if !scope_allowed(&app, &path) {
        return Err("无权访问该路径（不在已打开的目录内）".into());
    }
    let show_hidden = show_hidden.unwrap_or(false);
    let rd = fs::read_dir(&path).map_err(|e| io_err(e, "读取目录"))?;
    let mut dirs: Vec<DirEntryInfo> = Vec::new();
    let mut files: Vec<DirEntryInfo> = Vec::new();
    let mut scanned: usize = 0; // 已取大小的文件数（阈值控制，R-25）
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !show_hidden {
            if is_dir && NOISE_DIRS.contains(&name.as_str()) {
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
        }
        // 条目数超阈值后不再逐文件开句柄取大小（R-25）
        let get_size = files.len() + dirs.len() < META_THRESHOLD;
        let size = if is_dir || !get_size {
            0
        } else {
            scanned += 1;
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        let p = entry.path().to_string_lossy().into_owned();
        let info = DirEntryInfo { name, path: p, is_dir, size };
        if is_dir {
            dirs.push(info);
        } else {
            files.push(info);
        }
    }
    let _ = scanned;
    dirs.sort_by_key(|a| a.name.to_lowercase());
    files.sort_by_key(|a| a.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

/// 创建文件/文件夹（右键菜单用）
#[tauri::command]
pub fn create_file(
    app: AppHandle,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    if !scope_allowed(&app, &path) {
        return Err("无权在该目录创建（不在已打开的目录内）".into());
    }
    if is_dir {
        fs::create_dir(&path).map_err(|e| io_err(e, "创建文件夹"))
    } else {
        if Path::new(&path).exists() {
            return Err("文件已存在".into());
        }
        fs::write(&path, b"").map_err(|e| io_err(e, "创建文件"))
    }
}

/// 删除：优先回收站（Windows SHFileOperationW + FOF_ALLOWUNDO），失败/非 Windows 才永久删除
#[cfg(target_os = "windows")]
fn delete_to_recycle_bin(path: &str) -> bool {
    #[repr(C)]
    struct ShFileOpStructW {
        hwnd: *mut core::ffi::c_void,
        w_func: u32,
        p_from: *mut u16,
        p_to: *mut u16,
        f_flags: u16,
        f_any_operations_aborted: i32,
        h_name_mappings: *mut core::ffi::c_void,
        lpsz_progress_title: *const u16,
    }
    extern "system" {
        fn SHFileOperationW(lpFileOp: *mut ShFileOpStructW) -> i32;
    }
    const FO_DELETE: u32 = 3;
    const FOF_ALLOWUNDO: u16 = 0x0040; // 送到回收站
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOERRORUI: u16 = 0x0400;
    let mut from: Vec<u16> = path.encode_utf16().chain([0u16, 0u16]).collect();
    let mut op = ShFileOpStructW {
        hwnd: core::ptr::null_mut(),
        w_func: FO_DELETE,
        p_from: from.as_mut_ptr(),
        p_to: core::ptr::null_mut(),
        f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        f_any_operations_aborted: 0,
        h_name_mappings: core::ptr::null_mut(),
        lpsz_progress_title: core::ptr::null(),
    };
    unsafe { SHFileOperationW(&mut op) == 0 }
}

fn delete_path_inner(path: &str) -> Result<(), std::io::Error> {
    #[cfg(target_os = "windows")]
    if delete_to_recycle_bin(path) {
        return Ok(());
    }
    let p = Path::new(path);
    if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

/// 删除（进回收站，R-07）。注意：失败会 fallback 永久删除，避免用户想删删不掉。
#[tauri::command]
pub fn delete_path(app: AppHandle, path: String) -> Result<(), String> {
    if !scope_allowed(&app, &path) {
        return Err("无权删除该路径（不在已打开的目录内）".into());
    }
    delete_path_inner(&path).map_err(|e| io_err(e, "删除"))
}

/// 重命名（new_name 不允许含路径分隔符，防止移出作用域，R-07）
#[tauri::command]
pub fn rename_path(app: AppHandle, path: String, new_name: String) -> Result<(), String> {
    if new_name.contains('\\') || new_name.contains('/') || new_name.contains("..") {
        return Err("新名称不能包含路径分隔符".into());
    }
    if !scope_allowed(&app, &path) {
        return Err("无权重命名（不在已打开的目录内）".into());
    }
    let p = Path::new(&path);
    let parent = p.parent().ok_or("无法确定父目录")?;
    let target = parent.join(&new_name);
    if target.exists() {
        return Err("同名文件/目录已存在".into());
    }
    fs::rename(p, &target).map_err(|e| io_err(e, "重命名"))
}
