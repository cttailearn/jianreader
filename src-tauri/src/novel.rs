//! 小说模式：章节流式扫描 + 按章懒加载 + 章节写回
//!
//! 性能策略（design 7.x / 3.8）：
//! - scan_chapters 字节级按 \n 切行（UTF-8/GBK/Big5 的多字节序列不含 0x0A，字节切分安全）
//! - 章节标题必短于 30 字 → 只解码「字节长度 < 上限」的行，正文长行零解码开销
//! - 章节表仅存元数据 {title, start, end}，正文按章懒加载 read_chapter
//! - R-18：大文件用 BufReader 流式切行（不进整文件内存）；编码检测改用「头 256KB + 尾 256KB」有界采样
//! - R-10：UTF-16 扫描按大小端正确解码、剥 BOM、按 UTF-16 字节数计算偏移
//! - R-11：read_chapter 钳制区间+防御上限；write_chapter 校验 start<end 且原子写
//! - R-16a：BOM 字节序列按编码选择，has_bom 恒由真实文件头判定

use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use tauri::ipc::Response;
use tauri::AppHandle;

/// 章节元数据
#[derive(Serialize, Clone)]
pub struct ChapterInfo {
    pub title: String,
    /// 章节起始字节偏移（标题行首字节）
    pub start: u64,
    /// 章节结束字节偏移（下一章 start，最后一章 = 文件大小）
    pub end: u64,
    /// 1 = 卷/部/集/篇，2 = 章/节/回/话/幕/折/特殊章/数字/英文
    pub level: u8,
}

/// scan_chapters 返回体
#[derive(Serialize)]
pub struct ScanResult {
    pub chapters: Vec<ChapterInfo>,
    pub total_bytes: u64,
    pub is_novel: bool,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: String,
    /// 磁盘只读属性（小说标签同样禁止编辑）
    pub readonly: bool,
}

/// 章节扫描结果（内部）
struct ScanOut {
    chapters: Vec<ChapterInfo>,
    is_novel: bool,
    encoding: String,
    has_bom: bool,
    eol: String,
}

fn io_err(e: std::io::Error, action: &str) -> String {
    format!("{action}失败: {e}")
}

/// 编码 label 规范化（detect 返回 "UTF-16 LE"/"UTF-8 BOM" 等显示名，
/// encoding_rs::for_label 需要无空格的标准 label）
fn norm_label<'a>(label: &'a str) -> &'a str {
    match label {
        "UTF-16 LE" => "UTF-16LE",
        "UTF-16 BE" => "UTF-16BE",
        "UTF-8 BOM" => "UTF-8",
        other => other,
    }
}

/// 按编码解码一行（仅用于扫描标题；UTF-16 不走此路径）
fn decode_line(line: &[u8], encoding: &str) -> String {
    match encoding {
        "UTF-8" | "UTF-8 BOM" => String::from_utf8_lossy(line).into_owned(),
        label => {
            let enc = encoding_rs::Encoding::for_label(norm_label(label).as_bytes())
                .unwrap_or(encoding_rs::UTF_8);
            let (s, _, _) = enc.decode(line);
            s.into_owned()
        }
    }
}

fn is_chinese_num(c: char) -> bool {
    matches!(
        c,
        '零' | '〇' | '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十'
            | '百' | '千' | '万' | '两'
    )
}

/// 标题模式匹配：命中返回 Some(level)，否则 None
/// 要求：行首（允许空白）+ 短行（调用方保证 <30 字）
fn match_heading(line: &str) -> Option<u8> {
    let t = line.trim_start_matches([' ', '\t', '\u{3000}']);

    // 卷/部/集/篇/章/节/回/话/幕/折 —— 第X + 量词
    if let Some(rest) = t.strip_prefix('第') {
        let mut it = rest.chars().peekable();
        let mut n = 0usize;
        while let Some(&c) = it.peek() {
            if is_chinese_num(c) || c.is_ascii_digit() {
                n += 1;
                it.next();
            } else {
                break;
            }
        }
        if n > 0 {
            let unit = it.next();
            let level: Option<u8> = match unit {
                Some('卷') | Some('部') | Some('集') | Some('篇') => Some(1),
                Some('章') | Some('节') | Some('回') | Some('话') | Some('幕') | Some('折') => {
                    Some(2)
                }
                _ => None,
            };
            if let Some(lv) = level {
                return Some(lv);
            }
        }
    }

    // 特殊章（独立短词；整行 ≤10 字且词后只能跟分隔符）
    const SPECIALS: [&str; 16] = [
        "番外篇", "大结局", "卷首语", "序章", "楔子", "引子", "前言", "序言", "尾声", "后记",
        "终章", "番外", "外传", "附录", "结局", "正文",
    ];
    if t.chars().count() <= 10 {
        for s in SPECIALS {
            if t == s {
                return Some(2);
            }
            if let Some(rest) = t.strip_prefix(s) {
                let first = rest.chars().next().unwrap_or('\0');
                if matches!(first, ' ' | '　' | '：' | ':' | '－' | '-' | '（' | '(' | '·' | '、')
                    && t.chars().count() <= s.chars().count() + 6
                {
                    return Some(2);
                }
            }
        }
    }

    // 无"第"的卷：上卷/中卷/下卷/外卷
    const VOLUMES: [&str; 6] = ["上卷", "中卷", "下卷", "外卷", "前卷", "后卷"];
    for s in VOLUMES {
        if t == s {
            return Some(1);
        }
        if let Some(rest) = t.strip_prefix(s) {
            let first = rest.chars().next().unwrap_or('\0');
            if matches!(first, ' ' | '　' | '：' | ':' | '－' | '-' | '（' | '(' | '·' | '、') {
                return Some(1);
            }
        }
    }

    // 括号编号：（一）（1）【一】【1】(一)(1)[一][1]
    for (open, close) in [('（', '）'), ('(', ')'), ('【', '】'), ('[', ']')] {
        if let Some(rest) = t.strip_prefix(open) {
            let mut it = rest.chars().peekable();
            let mut n = 0usize;
            while let Some(&c) = it.peek() {
                if is_chinese_num(c) || c.is_ascii_digit() {
                    n += 1;
                    it.next();
                } else {
                    break;
                }
            }
            if (1..=4).contains(&n) && it.peek() == Some(&close) {
                return Some(2);
            }
        }
    }

    // 中文数字 + 顿号/句点/空格：一、标题 / 二．标题 / 三. 标题 / 十二 标题
    {
        let mut it = t.chars().peekable();
        let mut cn = 0usize;
        while let Some(&c) = it.peek() {
            if is_chinese_num(c) {
                cn += 1;
                it.next();
            } else {
                break;
            }
        }
        if (1..=3).contains(&cn) {
            match it.peek() {
                Some('、') | Some('．') | Some('，') | Some('.') | Some(' ') | Some('　') => {
                    return Some(2);
                }
                _ => {}
            }
        }
    }

    // 数字编号：纯数字行 或 "12. 标题" / "1、标题" / "3102 标题"
    let mut it = t.chars().peekable();
    let mut digits = 0usize;
    while let Some(&c) = it.peek() {
        if c.is_ascii_digit() {
            digits += 1;
            it.next();
        } else {
            break;
        }
    }
    if (1..=4).contains(&digits) {
        match it.peek() {
            None => return Some(2),
            Some('.') | Some('、') | Some('．') | Some('，') => return Some(2),
            Some(' ') | Some('　') => return Some(2),
            _ => {}
        }
    }

    // 英文：Chapter 12 / Part II / Episode 5 / Book 3 / Chapter One
    let upper = t.to_ascii_lowercase();
    const WORD_NUMS: [&str; 12] = [
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "twenty", "thirty",
    ];
    for prefix in ["chapter", "part", "episode", "book"] {
        if let Some(rest) = upper.strip_prefix(prefix) {
            let mut it = rest.chars().peekable();
            while let Some(c) = it.peek() {
                if c.is_whitespace() {
                    it.next();
                } else {
                    break;
                }
            }
            let mut n = 0usize;
            while let Some(&c) = it.peek() {
                if c.is_ascii_digit() {
                    n += 1;
                    it.next();
                } else if matches!(c, 'i' | 'v' | 'x' | 'l' | 'c') {
                    n += 1;
                    it.next();
                } else {
                    break;
                }
            }
            if n > 0 {
                return Some(2);
            }
            let word: String = it.clone().take(6).collect();
            let lower = word.trim();
            if WORD_NUMS.iter().any(|w| lower == *w || lower.starts_with(w)) {
                return Some(2);
            }
        }
    }

    None
}

/// 对一段「短行」统一做章节判定（内置规则或自定义正则）
fn level_of(trimmed: &str, custom_re: Option<&regex::Regex>) -> Option<u8> {
    if let Some(re) = custom_re {
        if re.is_match(trimmed) {
            return Some(2);
        }
        return None;
    }
    match_heading(trimmed)
}

/// 在整块切片上扫描章节（仅测试使用；生产走 scan_stream_file）
#[cfg(test)]
fn scan_bytes(
    bytes: &[u8],
    encoding: &str,
    has_bom: bool,
    custom_re: Option<&regex::Regex>,
) -> ScanOut {
    let total = bytes.len() as u64;
    // 短行字节上限：30 中文字符（GBK 2B/字 = 60；UTF-8 3B/字 = 96；留裕量）
    let max_line_bytes: usize = if custom_re.is_some() {
        256
    } else if encoding.starts_with("UTF-8") {
        96
    } else {
        64
    };
    let mut chapters: Vec<ChapterInfo> = Vec::new();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let offset: u64 = if has_bom { 3 } else { 0 };
    let mut line_start: u64 = offset;
    let mut i = offset as usize;
    let len = bytes.len();

    while i < len {
        let mut j = i;
        while j < len && bytes[j] != b'\n' {
            j += 1;
        }
        let mut line_end = j;
        if line_end > i && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
            crlf += 1;
        } else if j < len {
            lf += 1;
        }
        let line = &bytes[i..line_end];
        if !line.is_empty() && line.len() <= max_line_bytes {
            let text = decode_line(line, encoding);
            let trimmed = text.trim();
            let limit = if custom_re.is_some() { 60 } else { 30 };
            if !trimmed.is_empty() && trimmed.chars().count() <= limit {
                if let Some(level) = level_of(trimmed, custom_re) {
                    chapters.push(ChapterInfo {
                        title: trimmed.chars().take(40).collect(),
                        start: line_start,
                        end: 0,
                        level,
                    });
                }
            }
        }
        i = j + 1;
        line_start = i as u64;
    }

    finalize_chapters(&mut chapters, total);
    let eol = if crlf > lf { "\r\n" } else { "\n" }.to_owned();
    let is_novel = chapters.len() >= 3;
    ScanOut {
        chapters,
        is_novel,
        encoding: encoding.to_owned(),
        has_bom,
        eol,
    }
}

/// 流式扫描（R-18）：BufReader 逐行切分，不进整文件内存；大正文长行仅计数不作解码
/// 返回错误以 String（供命令直接传播）
fn scan_stream_file(
    path: &str,
    encoding: &str,
    has_bom: bool,
    custom_re: Option<&regex::Regex>,
) -> Result<ScanOut, String> {
    let f = fs::File::open(path).map_err(|e| io_err(e, "打开文件"))?;
    let total = f.metadata().map_err(|e| io_err(e, "读取文件信息"))?.len();
    let mut r = BufReader::with_capacity(1 << 20, f); // 1MB 缓冲
    // UTF-8 BOM：跳过 3 字节，使首个章节偏移与 scan_bytes 一致
    if has_bom && encoding.starts_with("UTF-8") && total >= 3 {
        r.seek(SeekFrom::Start(3))
            .map_err(|e| format!("定位文件失败: {e}"))?;
    }
    let max_line_bytes: usize = if custom_re.is_some() {
        256
    } else if encoding.starts_with("UTF-8") {
        96
    } else {
        64
    };
    let mut chapters: Vec<ChapterInfo> = Vec::new();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut off: u64 = if has_bom && encoding.starts_with("UTF-8") { 3 } else { 0 };
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    loop {
        buf.clear();
        let n = r
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("读取文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        let line_start = off;
        off += n as u64;
        // 剥 \r\n / \n
        let mut line_end = buf.len();
        if line_end > 0 && buf[line_end - 1] == b'\n' {
            line_end -= 1;
            if line_end > 0 && buf[line_end - 1] == b'\r' {
                line_end -= 1;
                crlf += 1;
            } else {
                lf += 1;
            }
        }
        let line = &buf[..line_end];
        if !line.is_empty() && line.len() <= max_line_bytes {
            let text = decode_line(line, encoding);
            let trimmed = text.trim();
            let limit = if custom_re.is_some() { 60 } else { 30 };
            if !trimmed.is_empty() && trimmed.chars().count() <= limit {
                if let Some(level) = level_of(trimmed, custom_re) {
                    chapters.push(ChapterInfo {
                        title: trimmed.chars().take(40).collect(),
                        start: line_start,
                        end: 0,
                        level,
                    });
                }
            }
        }
        if off >= total {
            break;
        }
    }
    finalize_chapters(&mut chapters, total);
    let is_novel = chapters.len() >= 3;
    Ok(ScanOut {
        chapters,
        is_novel,
        encoding: encoding.to_owned(),
        has_bom,
        eol: if crlf > lf { "\r\n" } else { "\n" }.to_owned(),
    })
}

/// 定 end：上一章的 end = 本章 start（最后一章 = 文件总长）
fn finalize_chapters(chapters: &mut Vec<ChapterInfo>, total: u64) {
    for idx in 0..chapters.len() {
        let next_start = chapters
            .get(idx + 1)
            .map(|c| c.start)
            .unwrap_or(total);
        chapters[idx].end = next_start;
    }
}

/// UTF-16 扫描（R-10 修复）：按大小端正确解码、剥 BOM、偏移按 UTF-16 字节数计算
fn scan_utf16(bytes: &[u8], encoding: &str, has_bom: bool, custom_re: Option<&regex::Regex>) -> ScanOut {
    let start = if has_bom { 2 } else { 0 };
    let text = match encoding {
        "UTF-16 BE" => encoding_rs::UTF_16BE.decode(&bytes[start..]).0.into_owned(),
        _ => encoding_rs::UTF_16LE.decode(&bytes[start..]).0.into_owned(),
    };
    let bom_bytes = if has_bom { 2u64 } else { 0u64 };
    let mut chapters: Vec<ChapterInfo> = Vec::new();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut line_start = 0usize; // UTF-8 字符索引（text 内）
    for line in text.split('\n') {
        let has_cr = line.ends_with('\r');
        let l = if has_cr { &line[..line.len() - 1] } else { line };
        if !l.is_empty() {
            if has_cr {
                crlf += 1;
            } else {
                lf += 1;
            }
            let trimmed = l.trim();
            if !trimmed.is_empty() && trimmed.chars().count() <= 30 {
                if let Some(level) = level_of(trimmed, custom_re) {
                    let byte_off = bom_bytes + (text[..line_start].encode_utf16().count() as u64) * 2;
                    chapters.push(ChapterInfo {
                        title: trimmed.chars().take(40).collect(),
                        start: byte_off,
                        end: 0,
                        level,
                    });
                }
            }
        }
        line_start = line_start + line.len() + 1;
    }
    let total = bom_bytes + (text.encode_utf16().count() as u64) * 2;
    finalize_chapters(&mut chapters, total.max(bom_bytes));
    ScanOut {
        chapters,
        is_novel: false, // UTF-16 罕见格式，不做小说模式（与既有行为一致）
        encoding: encoding.to_owned(),
        has_bom,
        eol: if crlf > lf { "\r\n" } else { "\n" }.to_owned(),
    }
}

/// 头部有 BOM 判定（供编码 override 时保留真实 has_bom，R-16a）
fn has_bom_from_head(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
}

/// 扫描章节表（小说模式判定入口）——无作用域校验的实现（供命令与集成测试共用）
/// - encoding_override：手动指定编码（乱码时切换），has_bom 仍由文件头判定
/// - custom_pattern：自定义章节正则
fn scan_chapters_impl(
    path: &str,
    encoding_override: Option<&str>,
    custom_pattern: Option<&str>,
) -> Result<ScanResult, String> {
    let meta = fs::metadata(path).map_err(|e| io_err(e, "读取文件"))?;
    let total_bytes = meta.len();
    let readonly = meta.permissions().readonly();
    if total_bytes == 0 {
        return Ok(ScanResult {
            chapters: vec![],
            total_bytes: 0,
            is_novel: false,
            encoding: "UTF-8".into(),
            has_bom: false,
            eol: "\n".into(),
            readonly,
        });
    }
    // 有界编码检测：头 256KB + 尾 256KB（R-18，避免整读大文件进 chardetng）
    let head_sz = total_bytes.min(256 * 1024);
    let head = read_range(path, 0, head_sz)?;
    let tail_start = total_bytes.saturating_sub(256 * 1024);
    let tail = if tail_start > head_sz {
        read_range(path, tail_start, total_bytes)?
    } else {
        Vec::new() // 尾巴与头重叠时跳过（文件较小，头已覆盖）
    };
    let mut sample = head;
    if !tail.is_empty() {
        sample.extend_from_slice(&tail);
    }
    let (det_enc, det_bom) = crate::fs::detect_encoding(&sample);
    let has_bom_real = has_bom_from_head(&sample);
    let (encoding, has_bom) = match encoding_override {
        Some(enc) => (enc.to_owned(), has_bom_real),
        None => (det_enc, det_bom),
    };
    let custom_re = custom_pattern
        .map(|p| regex::Regex::new(p))
        .transpose()
        .map_err(|e| format!("正则无效: {e}"))?;

    let out = if encoding.starts_with("UTF-16") {
        // UTF-16 罕见：整读解码（可接受）
        let bytes = fs::read(path).map_err(|e| io_err(e, "读取文件"))?;
        scan_utf16(&bytes, &encoding, has_bom, custom_re.as_ref())
    } else {
        // 流式扫描（自己打开文件，内存有界）
        scan_stream_file(path, &encoding, has_bom, custom_re.as_ref())?
    };

    Ok(ScanResult {
        chapters: out.chapters,
        total_bytes,
        is_novel: out.is_novel,
        encoding: out.encoding,
        has_bom: out.has_bom,
        eol: out.eol,
        readonly,
    })
}

/// 读取文件 [start, end) 字节区间（有界分配）
fn read_range(path: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
    let mut f = fs::File::open(path).map_err(|e| io_err(e, "打开文件"))?;
    let len = (end.saturating_sub(start)) as usize;
    if len > 256 * 1024 * 1024 {
        return Err("读取区间过大".into());
    }
    let mut buf = vec![0u8; len];
    f.seek(SeekFrom::Start(start)).map_err(|e| format!("定位文件失败: {e}"))?;
    let read = f.read(&mut buf).map_err(|e| format!("读取文件失败: {e}"))?;
    buf.truncate(read);
    Ok(buf)
}

/// 扫描章节表命令（入口带作用域校验）
#[tauri::command]
pub fn scan_chapters(
    app: AppHandle,
    path: String,
    encoding_override: Option<String>,
    custom_pattern: Option<String>,
) -> Result<ScanResult, String> {
    if !crate::fs::scope_allowed(&app, &path) {
        return Err("无权访问该路径（不在已打开的目录内）".into());
    }
    scan_chapters_impl(&path, encoding_override.as_deref(), custom_pattern.as_deref())
}

/// 把读取块末尾截断到字符边界（分页懒加载拼接时不产生乱码）
fn trim_trailing_partial_char(buf: &[u8], encoding: &str) -> usize {
    if buf.is_empty() {
        return 0;
    }
    if encoding.starts_with("UTF-8") {
        let mut i = buf.len();
        while i > 0 && (buf[i - 1] & 0xC0) == 0x80 {
            i -= 1;
        }
        if i == 0 {
            return 0;
        }
        let lead = buf[i - 1];
        let char_len = if lead < 0x80 {
            1
        } else if (lead & 0xE0) == 0xC0 {
            2
        } else if (lead & 0xF0) == 0xE0 {
            3
        } else {
            4
        };
        if buf.len() - (i - 1) < char_len {
            i - 1
        } else {
            buf.len()
        }
    } else if encoding.starts_with("UTF-16") {
        buf.len() - (buf.len() % 2)
    } else {
        let enc = encoding_rs::Encoding::for_label(norm_label(encoding).as_bytes())
            .unwrap_or(encoding_rs::UTF_8);
        let mut len = buf.len();
        for _ in 0..2 {
            if len == 0 {
                break;
            }
            let (s, _, had_errors) = enc.decode(&buf[..len]);
            if !had_errors || !s.ends_with('\u{FFFD}') {
                return len;
            }
            len -= 1;
        }
        len
    }
}

/// 按章懒加载（不含作用域校验的实现，测试可直接调用）
fn read_chapter_impl(path: &str, start: u64, end: u64, encoding: &str) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| io_err(e, "打开文件"))?;
    let total = f.metadata().map_err(|e| io_err(e, "读取文件信息"))?.len();
    // R-11：区间钳制到文件长度，避免越界/超大分配
    let s = start.min(total);
    let e = end.min(total).max(s);
    let len = (e - s) as usize;
    if len > 64 * 1024 * 1024 {
        return Err("单次章节读取过大（>64MB），请检查章节偏移".into());
    }
    let mut buf = vec![0u8; len];
    f.seek(SeekFrom::Start(s)).map_err(|e| format!("定位章节失败: {e}"))?;
    let read = f.read(&mut buf).map_err(|e| format!("读取章节失败: {e}"))?;
    buf.truncate(read);
    let keep = trim_trailing_partial_char(&buf, encoding);
    buf.truncate(keep);
    let enc = encoding_rs::Encoding::for_label(norm_label(encoding).as_bytes())
        .unwrap_or(encoding_rs::UTF_8);
    let (s_, _, _) = enc.decode(&buf);
    Ok(s_.into_owned())
}

/// 按章懒加载命令（R-20）：返回原始 UTF-8 字节（tauri::ipc::Response），
/// 前端用 TextDecoder 解码 —— 几十 MB 文本不再走 JSON 序列化/解析，大幅降低 IPC 开销与峰值内存。
#[tauri::command]
pub fn read_chapter(
    app: AppHandle,
    path: String,
    start: u64,
    end: u64,
    encoding: String,
) -> Result<Response, String> {
    if !crate::fs::scope_allowed(&app, &path) {
        return Err("无权访问该路径（不在已打开的目录内）".into());
    }
    let text = read_chapter_impl(&path, start, end, &encoding)?;
    Ok(Response::new(text.into_bytes()))
}

/// 章节写回核心逻辑（不含作用域/callback，测试直接调用）：整文件读 → 替换区间 → 原子写回
fn write_chapter_impl(
    path: &str,
    start: u64,
    end: u64,
    content: &str,
    encoding: &str,
    has_bom: bool,
    eol: &str,
) -> Result<u64, String> {
    let bytes = fs::read(path).map_err(|e| io_err(e, "读取文件"))?;
    let len = bytes.len() as u64;
    // R-11：区间合法性/钳制
    let s = start.min(len);
    let e = end.min(len);
    if s >= e {
        return Err("章节区间无效（start >= end）".into());
    }
    let normalized = crate::fs::normalize_eol(content, eol);
    // R-16a：BOM 字节序列按编码选择；仅当写回首章且原文件有 BOM 时补 BOM
    let repl = crate::fs::encode_text(&normalized, encoding, start == 0 && has_bom)?;
    let mut out: Vec<u8> = Vec::with_capacity(len as usize - (e - s) as usize + repl.len());
    out.extend_from_slice(&bytes[..s as usize]);
    out.extend_from_slice(&repl);
    out.extend_from_slice(&bytes[e as usize..]);
    crate::fs::atomic_write(path, &out).map_err(|e| io_err(e, "写入文件"))?;
    Ok(out.len() as u64)
}

/// 章节写回命令
#[tauri::command]
pub fn write_chapter(
    app: AppHandle,
    path: String,
    start: u64,
    end: u64,
    content: String,
    encoding: String,
    has_bom: bool,
    eol: String,
) -> Result<u64, String> {
    if !crate::fs::scope_allowed(&app, &path) {
        return Err("无权写入该路径（不在已打开的目录内）".into());
    }
    if start >= end {
        return Err("章节区间无效（start >= end）".into());
    }
    let size = write_chapter_impl(&path, start, end, &content, &encoding, has_bom, &eol)?;
    crate::watcher::register_saved(&app, &path);
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(s: &str) -> Vec<(String, u8, u64, u64)> {
        let out = scan_bytes(s.as_bytes(), "UTF-8", false, None);
        out.chapters
            .iter()
            .map(|c| (c.title.clone(), c.level, c.start, c.end))
            .collect()
    }

    #[test]
    fn chinese_chapters() {
        let s = "第一章 少年崛起\n少年在山村长大，日子清苦。\n第二章 修炼\n他踏上修炼之路，历尽艰辛。\n第12章 突破\n三年后，他终于突破了。\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].0, "第一章 少年崛起");
        assert_eq!(ch[1].0, "第二章 修炼");
        assert_eq!(ch[2].0, "第12章 突破");
        assert_eq!(ch[0].3, ch[1].2);
        assert_eq!(ch[1].3, ch[2].2);
    }

    #[test]
    fn volumes_and_specials() {
        let s = "第一卷 风起\n序章\n楔子\n第一章 开始\n故事从这里开始。\n第二章 结束\n尾声\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 6);
        assert_eq!(ch[0].0, "第一卷 风起");
        assert_eq!(ch[0].1, 1);
        assert_eq!(ch[1].0, "序章");
        assert_eq!(ch[2].0, "楔子");
        assert_eq!(ch[5].0, "尾声");
    }

    #[test]
    fn numeric_and_english() {
        let s = "1\n内容\n2. 标题\n内容\nChapter 3\nThe End\nPart II\n内容\n";
        let ch = scan(s);
        assert!(ch.iter().any(|c| c.0 == "1"));
        assert!(ch.iter().any(|c| c.0 == "2. 标题"));
        assert!(ch.iter().any(|c| c.0 == "Chapter 3"));
        assert!(ch.iter().any(|c| c.0 == "Part II"));
    }

    #[test]
    fn prose_no_false_positive() {
        let s = "今天天气很好，我出门散步。\n路上遇到了老朋友，他说要请我吃饭。\n我们聊了很久，回忆起当年的往事。\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 0);
    }

    #[test]
    fn long_line_not_heading() {
        let mut line = String::from("第一章");
        for _ in 0..40 {
            line.push_str("这是一段很长的正文内容");
        }
        let s = format!("{line}\n第二章 正常\n情节继续发展。\n第三章 正常\n");
        let ch = scan(&s);
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[0].0, "第二章 正常");
    }

    #[test]
    fn gbk_decoding() {
        let gbk = encoding_rs::GBK;
        let (enc, _, _) = gbk.encode("第一章 测试\n这是正文内容。\n第二章 继续\n");
        let out = scan_bytes(&enc, "GBK", false, None);
        assert_eq!(out.chapters.len(), 2);
        assert_eq!(out.chapters[0].title, "第一章 测试");
    }

    #[test]
    fn crlf_handling() {
        let s = "第一章\r\n故事开始了。\r\n第二章\r\n情节推进中。\r\n第三章\r\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].0, "第一章");
        assert_eq!(ch[1].2, ch[0].3);
    }

    #[test]
    fn paren_numbers() {
        let s = "（一）初入江湖\n内容\n(2) 遇险\n内容\n【三】拜师\n内容\n[4] 下山\n内容\n（五）终章\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 5);
        assert_eq!(ch[0].0, "（一）初入江湖");
        assert_eq!(ch[1].0, "(2) 遇险");
        assert_eq!(ch[2].0, "【三】拜师");
        assert_eq!(ch[3].0, "[4] 下山");
        assert_eq!(ch[4].0, "（五）终章");
    }

    #[test]
    fn chinese_num_list() {
        let s = "一、相遇\n内容\n二、相知\n内容\n三. 相守\n内容\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].0, "一、相遇");
        assert_eq!(ch[1].0, "二、相知");
        assert_eq!(ch[2].0, "三. 相守");
    }

    #[test]
    fn volumes_without_di() {
        let s = "上卷 风起\n第一章 开始\n中卷\n下卷 归途\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 4);
        assert_eq!(ch[0].0, "上卷 风起");
        assert_eq!(ch[0].1, 1);
        assert_eq!(ch[1].0, "第一章 开始");
        assert_eq!(ch[1].1, 2);
        assert_eq!(ch[2].0, "中卷");
        assert_eq!(ch[3].0, "下卷 归途");
    }

    #[test]
    fn specials_extended() {
        let s = "番外篇\n番外 双人游\n大结局\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].0, "番外篇");
        assert_eq!(ch[1].0, "番外 双人游");
        assert_eq!(ch[2].0, "大结局");
    }

    #[test]
    fn english_word_numbers() {
        let s = "Chapter One\nstory\nChapter Two\nstory\nPart Three\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].0, "Chapter One");
        assert_eq!(ch[2].0, "Part Three");
    }

    #[test]
    fn number_space_title() {
        let s = "3101 言\n内容\n3102 一人一龟\n内容\n3103 威尼斯商界峰会\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].0, "3101 言");
        assert_eq!(ch[1].0, "3102 一人一龟");
    }

    #[test]
    fn custom_regex_chapters() {
        let re = regex::Regex::new(r"^【.+】").unwrap();
        let s = "【001】序章\n内容\n【002】第一章\n内容\n【003】终章\n";
        let out = scan_bytes(s.as_bytes(), "UTF-8", false, Some(&re));
        assert_eq!(out.chapters.len(), 3);
        assert_eq!(out.chapters[0].title, "【001】序章");
        assert_eq!(out.chapters[2].title, "【003】终章");
        let re2 = regex::Regex::new(r"^第X章").unwrap();
        let out2 = scan_bytes(s.as_bytes(), "UTF-8", false, Some(&re2));
        assert_eq!(out2.chapters.len(), 0);
    }

    #[test]
    fn utf16_without_bom_detected() {
        let long =
            "第一章 测试，这是正文内容，用于编码检测验证。第二章 继续，更多正文内容。第三章 结束。\n";
        let mut u16bytes: Vec<u8> = Vec::new();
        for ch in long.encode_utf16() {
            u16bytes.extend_from_slice(&ch.to_le_bytes());
        }
        assert!(u16bytes.len() >= 64);
        let (enc, bom) = crate::fs::detect_encoding(&u16bytes);
        assert_eq!(enc, "UTF-16 LE");
        assert!(!bom);
    }

    #[test]
    fn gbk_fallback_detection() {
        let (enc_bytes, _, _) = encoding_rs::GBK.encode(
            "第一章 测试，这是正文内容，用于编码检测验证。第二章 继续，更多正文内容。第三章 结束。\n",
        );
        let (enc, bom) = crate::fs::detect_encoding(&enc_bytes);
        assert_eq!(enc, "GBK", "GBK 中文不应被误判为拉丁系");
        assert!(!bom);
        let ascii = b"The quick brown fox jumps over the lazy dog. Hello world 123.\n".to_vec();
        let (enc2, _) = crate::fs::detect_encoding(&ascii);
        assert_eq!(enc2, "UTF-8");
    }

    #[test]
    fn ascii_head_gbk_body() {
        let head = "The Complete Novel Series\nAuthor: Unknown\n\
This is a sample book with ascii header exceeding sixty four kilobytes of pure text.\n"
            .repeat(1200);
        assert!(head.len() > 65536, "头部需超过 64KB: {}", head.len());
        let (gbk, _, _) = encoding_rs::GBK.encode(
            "第一章 测试\n这是正文内容，验证头部ASCII时正文GBK不乱码。\n第二章 继续\n",
        );
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(&gbk);
        let (enc, _) = crate::fs::detect_encoding(&bytes);
        assert_eq!(enc, "GBK", "ASCII 头 + GBK 正文必须检测为 GBK");

        let dir = std::env::temp_dir();
        let p = dir.join("jianyue-ascii-head-gbk-test.txt");
        std::fs::write(&p, &bytes).unwrap();
        let r = {
            let ps = p.to_string_lossy().into_owned();
            scan_chapters_impl(&ps, None, None).unwrap()
        };
        let _ = std::fs::remove_file(&p);
        assert_eq!(r.encoding, "GBK");
        assert_eq!(r.chapters[0].title, "第一章 测试");
        assert!(r.chapters.len() >= 2);
    }

    #[test]
    fn prose_no_false_positive_extended() {
        let s = "我们谈到（一）个话题，聊了很久。\n他说（2）年前的事，我记不清了。\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 0);
        let s2 = "一、这是一段很长很长的正文叙述内容，超过了三十个字的限制所以不会被认为是章节标题。\n";
        let ch2 = scan(s2);
        assert_eq!(ch2.len(), 0);
    }

    #[test]
    fn trim_partial_utf8() {
        let text = "第一章 测试\n这是正文内容，包含中文。\n第二章\n";
        let bytes = text.as_bytes();
        for cut in 0..bytes.len() {
            let keep = trim_trailing_partial_char(&bytes[..cut], "UTF-8");
            let s = String::from_utf8_lossy(&bytes[..keep]);
            let rem = trim_trailing_partial_char(&bytes[keep..], "UTF-8");
            let s2 = String::from_utf8_lossy(&bytes[keep..keep + rem]);
            let joined = format!("{s}{s2}");
            assert!(!joined.contains('\u{FFFD}'), "cut={cut} 拼接有替换字符: {joined}");
            assert_eq!(joined, text, "cut={cut} 拼接不一致");
        }
    }

    #[test]
    fn trim_partial_gbk() {
        let (enc, _, _) = encoding_rs::GBK.encode("第一章 测试\n这是正文内容。\n");
        for cut in 0..enc.len() {
            let keep = trim_trailing_partial_char(&enc[..cut], "GBK");
            let s = encoding_rs::GBK.decode(&enc[..keep]).0;
            let rem = trim_trailing_partial_char(&enc[keep..], "GBK");
            let s2 = encoding_rs::GBK.decode(&enc[keep..keep + rem]).0;
            let joined = format!("{s}{s2}");
            assert!(!joined.contains('\u{FFFD}'), "cut={cut} 拼接有替换字符");
            assert_eq!(joined, "第一章 测试\n这是正文内容。\n", "cut={cut} 拼接不一致");
        }
    }

    // 流式扫描与整块扫描结果一致（R-18 回归）
    use std::sync::atomic::{AtomicUsize, Ordering};
    static TMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn stream_scan_content(content: &str, encoding: &str, has_bom: bool) -> ScanOut {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir();
        let p = dir.join(format!("jianyue-stream-{}-{}.txt", std::process::id(), seq));
        std::fs::write(&p, content).unwrap();
        let out = {
            let ps = p.to_string_lossy().into_owned();
            scan_stream_file(&ps, encoding, has_bom, None).unwrap()
        };
        let _ = std::fs::remove_file(p);
        out
    }

    #[test]
    fn stream_matches_bytes_scan() {
        let s = "第一章 测试\n这是正文内容。\n\n第二章 继续\n正文再来一段。\n第三章 结束\n";
        let bytes_out = scan_bytes(s.as_bytes(), "UTF-8", false, None);
        let stream_out = stream_scan_content(s, "UTF-8", false);
        assert_eq!(bytes_out.chapters.len(), stream_out.chapters.len());
        for (a, b) in bytes_out.chapters.iter().zip(stream_out.chapters.iter()) {
            assert_eq!((a.title.as_str(), a.start, a.end), (b.title.as_str(), b.start, b.end));
        }
        assert_eq!(stream_out.eol, "\n");
    }

    #[test]
    fn stream_handles_bom_and_crlf() {
        let s = "\u{FEFF}第一章\r\n正文\r\n第二章\r\n内容\r\n";
        let out = stream_scan_content(s, "UTF-8", true);
        assert_eq!(out.chapters[0].title, "第一章");
        assert_eq!(out.chapters[0].start, 3);
        assert_eq!(out.eol, "\r\n");
    }

    // UTF-16 扫描（R-10 修复）回归
    #[test]
    fn utf16_le_scan_offsets_and_readback_real() {
        let long = "第一章 测试，这是正文内容。\n第二章 继续，更多正文。\n第三章 结束。\n";
        let mut v: Vec<u8> = vec![0xFF, 0xFE];
        for u in long.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        let dir = std::env::temp_dir();
        let p = dir.join("jianyue-utf16le-scan2.txt");
        std::fs::write(&p, &v).unwrap();
        let out = scan_utf16(&v, "UTF-16 LE", true, None);
        assert_eq!(out.chapters.len(), 3);
        assert_eq!(out.chapters[0].title, "第一章 测试，这是正文内容。");
        // 偏移正确：BOM(2) + 标题行 UTF-16 字节数（含换行）→ 第二章行起点
        // “第一章 测试，这是正文内容。\n” = 14 字符 + 1 换行 = 15 code units = 30B → 起点=2+30
        assert_eq!(out.chapters[1].start, 32);
        // 用 read_chapter_impl 读第二章回来（以字节偏移定位）
        let body = read_chapter_impl(&p.to_string_lossy().into_owned(), out.chapters[1].start, out.chapters[2].start, "UTF-16 LE").unwrap();
        assert!(body.starts_with("第二章 继续"), "读回内容不对: {body}");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn utf16_be_scan_offsets() {
        let long = "序章\n第一章 起点\n第二章 发展\n第三章 收尾\n";
        let mut v: Vec<u8> = vec![0xFE, 0xFF];
        for u in long.encode_utf16() {
            v.extend_from_slice(&u.to_be_bytes());
        }
        let out = scan_utf16(&v, "UTF-16 BE", true, None);
        assert!(out.chapters.iter().any(|c| c.title == "第一章 起点"));
        assert!(out.chapters.iter().any(|c| c.title == "第二章 发展"));
    }

    #[test]
    fn fixture_utf8_roundtrip() {
        let path = format!("{}/../test-fixtures/test-novel.txt", env!("CARGO_MANIFEST_DIR"));
        let r = scan_chapters_impl(&path, None, None).unwrap();
        assert!(r.is_novel, "UTF-8 fixture 应判为小说");
        assert_eq!(r.encoding, "UTF-8");
        assert!(r.chapters.len() >= 3);
        assert_eq!(r.chapters[0].title, "第1章 测试章节标题");

        let c0 = &r.chapters[0];
        let text = read_chapter_impl(&path, c0.start, c0.end, &r.encoding).unwrap();
        assert!(text.contains("第1章 测试章节标题"));
        assert!(text.contains("正文内容"));

        let size = write_chapter_impl(
            &path,
            c0.start,
            c0.end,
            &text,
            &r.encoding,
            r.has_bom,
            &r.eol,
        )
        .unwrap();
        assert_eq!(size, r.total_bytes);

        let r2 = scan_chapters_impl(&path, None, None).unwrap();
        assert_eq!(r2.chapters.len(), r.chapters.len());
    }

    #[test]
    fn fixture_gbk_novel() {
        let path = format!("{}/../test-fixtures/test-novel-gbk.txt", env!("CARGO_MANIFEST_DIR"));
        let r = scan_chapters_impl(&path, None, None).unwrap();
        assert!(r.is_novel, "GBK fixture 应判为小说");
        assert_eq!(r.encoding, "GBK");
        assert_eq!(r.chapters[0].title, "第1章 测试章节标题");
        let c0 = &r.chapters[0];
        let text = read_chapter_impl(&path, c0.start, c0.end, &r.encoding).unwrap();
        assert!(text.contains("正文内容"));
    }

    // 大文件流式基准（R-18：内存有界）
    #[test]
    fn stream_scan_large_chapter_no_chapters() {
        // 长正文行（>96B，非标题）不会产生章节，流式只计数不解码
        let line = "这是一段非常非常长的正文内容，用于验证流式扫描对长行只计数不解码，不会造成性能或内存问题。";
        assert!(line.len() > 96);
        let mut s = String::new();
        for _ in 0..5000 {
            s.push_str(line);
            s.push('\n');
        }
        let out = stream_scan_content(&s, "UTF-8", false);
        assert_eq!(out.chapters.len(), 0);
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use std::time::Instant;

    /// 50MB 小说扫描基准（cargo test bench_50mb -- --ignored --nocapture）
    #[test]
    #[ignore]
    fn bench_50mb() {
        let mut s = String::with_capacity(50 * 1024 * 1024);
        for i in 1..=5200 {
            s.push_str(&format!("第{i}章 章节标题\n"));
            for _ in 0..100 {
                s.push_str("这是一段很长的正文内容，用于填充章节体积，模拟真实小说的段落文字。");
                s.push('\n');
            }
        }
        // 写临时文件测流式路径
        let p = std::env::temp_dir().join("jianyue-bench-50mb.txt");
        std::fs::write(&p, s.as_bytes()).unwrap();
        let t0 = Instant::now();
        let out = {
            let ps = p.to_string_lossy().into_owned();
            scan_stream_file(&ps, "UTF-8", false, None).unwrap()
        };
        let ms = t0.elapsed().as_millis();
        eprintln!("scan 50MB(stream): {ms}ms, chapters: {}", out.chapters.len());
        assert_eq!(out.chapters.len(), 5200);
        assert!(ms < 1000, "50MB 扫描应 <1s，实际 {ms}ms");
        let _ = std::fs::remove_file(p);
    }
}
