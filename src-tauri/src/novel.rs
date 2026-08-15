//! 小说模式：章节流式扫描 + 按章懒加载 + 章节写回
//!
//! 性能策略（design 7.x / 3.8）：
//! - scan_chapters 字节级按 \n 切行（UTF-8/GBK/Big5 的多字节序列不含 0x0A，
//!   字节切分安全；UTF-16 走 BOM 全解码兜底）
//! - 章节标题必短于 30 字 → 只解码「字节长度 < 上限」的行（GBK 60B / UTF-8 96B），
//!   正文长行零解码开销，50MB 扫描 <1s
//! - 章节表仅存元数据 {title, start, end}，正文按章懒加载 read_chapter

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};

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

/// GBK 序列合法性检测：头部 64KB 中，单字节 ASCII + 合法双字节对（前导 0x81-0xFE + 续 0x40-0xFE）
/// 占比 ≥95% 视为"像 GBK"。用于 chardetng 误判拉丁系编码时的兜底（M8：中文 txt 乱码修复）。
#[allow(dead_code)]
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
#[allow(dead_code)]
fn is_cjk_encoding(name: &str) -> bool {
    matches!(
        name,
        "GBK" | "GB18030" | "GB2312" | "Big5" | "EUC-KR" | "EUC-JP" | "Shift_JIS" | "UTF-16"
            | "UTF-16LE"
            | "UTF-16BE" | "windows-949" | "ISO-2022-JP" | "ISO-2022-KR"
    ) || name.starts_with("UTF-16")
}

/// 编码检测（只喂头部 64KB；BOM 优先 → UTF-8 校验 → UTF-16 无 BOM 启发 → chardetng + GBK 兜底）
/// 与 fs.rs 的 decode_text 共用同一套检测逻辑（fs.rs 为唯一实现）
fn detect_encoding(bytes: &[u8]) -> (String, bool) {
    crate::fs::detect_encoding(bytes)
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

/// 按编码解码一行（仅用于扫描标题；UTF-16 在此路径不会出现）
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
    // 支持中文数字与阿拉伯数字混排，如 第12章 / 第一千零三回
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
                // 后面允许跟任意标题文字（短行已保证）
                return Some(lv);
            }
        }
    }

    // 特殊章（独立短词；整行 ≤10 字且词后只能跟分隔符，避免“正文……”类散文误判）
    // 注意：长的在前（番外篇 先于 番外），避免前缀截断
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

    // 无"第"的卷：上卷/中卷/下卷/外卷（独立或后跟标题）
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

    // 括号编号：（一）（1）【一】【1】(一)(1)[一][1]，后跟任意标题文字（短行已保证）
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

    // 数字编号：纯数字行（1 / 12 / 100）或 "12. 标题" / "1、标题"
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
            None => return Some(2),                                   // 纯数字
            Some('.') | Some('、') | Some('．') | Some('，') => return Some(2), // "12. 标题"
            Some(' ') | Some('　') => return Some(2),                 // "3102 标题"（M8）
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
            // 单词数字：Chapter One / Part Two
            let word: String = it.clone().take(6).collect();
            let lower = word.trim();
            if WORD_NUMS.iter().any(|w| lower == *w || lower.starts_with(w)) {
                return Some(2);
            }
        }
    }

    None
}

/// 流式扫描章节表：字节切行 + 只解码短行
fn scan_bytes(
    bytes: &[u8],
    encoding: &str,
    has_bom: bool,
    custom_re: Option<&regex::Regex>,
) -> ScanOut {
    let total = bytes.len() as u64;
    // 短行字节上限：30 中文字符（GBK 2B/字 = 60；UTF-8 3B/字 = 96；留裕量）
    // 自定义正则场景放宽到 256B（用户正则可能匹配稍长标题行）
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
    let offset: u64 = if has_bom { 3 } else { 0 }; // UTF-8 BOM 不占章节正文起点
    let mut line_start: u64 = offset;
    let mut i = offset as usize;
    let len = bytes.len();

    while i < len {
        // 找行尾
        let mut j = i;
        while j < len && bytes[j] != b'\n' {
            j += 1;
        }
        let mut line_end = j; // 不含 \n
        if line_end > i && bytes[line_end - 1] == b'\r' {
            line_end -= 1; // 去 \r
            crlf += 1;
        } else if j < len {
            lf += 1;
        }
        let line = &bytes[i..line_end];
        // 只解码短行（长行不可能是标题）
        if !line.is_empty() && line.len() <= max_line_bytes {
            let text = decode_line(line, encoding);
            let trimmed = text.trim();
            // 30 字上限（含标题后文字；自定义正则场景放宽到 60 字）
            let limit = if custom_re.is_some() { 60 } else { 30 };
            if !trimmed.is_empty() && trimmed.chars().count() <= limit {
                let level = if let Some(re) = custom_re {
                    // 自定义正则：匹配行即视为章节（用户自己控制规则）
                    if re.is_match(trimmed) {
                        Some(2)
                    } else {
                        None
                    }
                } else {
                    match_heading(trimmed)
                };
                if let Some(level) = level {
                    chapters.push(ChapterInfo {
                        title: trimmed.chars().take(40).collect(),
                        start: line_start,
                        end: 0, // 待定：下一章 start 或文件尾
                        level,
                    });
                }
            }
        }
        i = j + 1;
        line_start = i as u64;
    }

    // 定 end：上一章的 end = 本章 start
    for idx in 0..chapters.len() {
        let next_start = chapters
            .get(idx + 1)
            .map(|c| c.start)
            .unwrap_or(total);
        chapters[idx].end = next_start;
    }
    let is_novel = chapters.len() >= 3;
    let eol = if crlf > lf {
        "\r\n".to_owned()
    } else {
        "\n".to_owned()
    };
    ScanOut {
        chapters,
        is_novel,
        encoding: encoding.to_owned(),
        has_bom,
        eol,
    }
}

/// 扫描章节表（小说模式判定入口）
/// - encoding_override：阅读设置手动指定编码时跳过自动检测（乱码时切换用）
/// - custom_pattern：阅读设置自定义章节正则（逐行匹配，行首优先）
#[tauri::command]
pub fn scan_chapters(
    path: String,
    encoding_override: Option<String>,
    custom_pattern: Option<String>,
) -> Result<ScanResult, String> {
    let bytes = fs::read(&path).map_err(|e| io_err(e, "读取文件"))?;
    let total_bytes = bytes.len() as u64;
    let readonly = fs::metadata(&path)
        .map(|m| m.permissions().readonly())
        .unwrap_or(false);
    let (encoding, has_bom) = match encoding_override {
        Some(enc) => (enc, false),
        None => detect_encoding(&bytes[..bytes.len().min(65536)]),
    };

    // 自定义正则（用户提供，逐行匹配；只对短行执行控制开销）
    let custom_re = custom_pattern
        .as_deref()
        .map(|p| regex::Regex::new(p))
        .transpose()
        .map_err(|e| format!("正则无效: {e}"))?;

    // UTF-16 罕见路径：全解码后按行扫描（字符切行）
    let out = if encoding.starts_with("UTF-16") {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes);
        scan_utf16_str(&s, &encoding, has_bom)
    } else {
        scan_bytes(&bytes, &encoding, has_bom, custom_re.as_ref())
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

/// UTF-16 兜底扫描（字符级切行，不走字节优化）
fn scan_utf16_str(text: &str, encoding: &str, has_bom: bool) -> ScanOut {
    let mut chapters: Vec<ChapterInfo> = Vec::new();
    let mut offset = 0usize; // 字符偏移（UTF-16 下与字节偏移换算 2:1，仅兜底用途）
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut line_start = 0usize;
    for line in text.split('\n') {
        let l = line.strip_suffix('\r').unwrap_or(line);
        if !l.is_empty() {
            crlf += (line.ends_with('\r') && !line.is_empty()) as usize;
            lf += (!line.ends_with('\r') || line.is_empty()) as usize;
            let trimmed = l.trim();
            if !trimmed.is_empty() && trimmed.chars().count() <= 30 {
                if let Some(level) = match_heading(trimmed) {
                    chapters.push(ChapterInfo {
                        title: trimmed.chars().take(40).collect(),
                        start: (line_start * 2) as u64,
                        end: 0,
                        level,
                    });
                }
            }
        }
        line_start = offset + line.len() + 1;
        offset = line_start;
    }
    let total = (text.len() * 2) as u64;
    for idx in 0..chapters.len() {
        let next = chapters.get(idx + 1).map(|c| c.start).unwrap_or(total);
        chapters[idx].end = next;
    }
    ScanOut {
        chapters,
        is_novel: false, // UTF-16 走普通编辑（罕见格式，不做小说模式）
        encoding: encoding.to_owned(),
        has_bom,
        eol: if crlf > lf { "\r\n" } else { "\n" }.to_owned(),
    }
}

/// 把读取块末尾截断到字符边界（分页懒加载拼接时不产生乱码）
/// UTF-8：末尾若为多字节序列的一部分则截掉；GBK/Big5：末尾若为双字节前导字节则截掉
fn trim_trailing_partial_char(buf: &[u8], encoding: &str) -> usize {
    if buf.is_empty() {
        return 0;
    }
    if encoding.starts_with("UTF-8") {
        let mut i = buf.len();
        while i > 0 && (buf[i - 1] & 0xC0) == 0x80 {
            i -= 1; // 回退到字符起始
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
            i - 1 // 字符被切断 → 去掉不完整部分
        } else {
            buf.len()
        }
    } else if encoding.starts_with("UTF-16") {
        buf.len() - (buf.len() % 2)
    } else {
        // GBK/Big5 等：前导/续字节范围重叠，无法按字节判定边界。
        // 直接用解码结果回退：末尾若为截断产生的替换字符（U+FFFD），回退 1 字节重试（双字节编码最多回退 1）。
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

/// 按章节懒加载：读 [start, end) 字节范围并解码（自动对齐字符边界）
#[tauri::command]
pub fn read_chapter(path: String, start: u64, end: u64, encoding: String) -> Result<String, String> {
    let mut f = fs::File::open(&path).map_err(|e| io_err(e, "打开文件"))?;
    let len = (end.saturating_sub(start)) as usize;
    let mut buf = vec![0u8; len];
    f.seek(SeekFrom::Start(start)).map_err(|e| io_err(e, "定位章节"))?;
    let read = f.read(&mut buf).map_err(|e| io_err(e, "读取章节"))?;
    buf.truncate(read);
    let keep = trim_trailing_partial_char(&buf, &encoding);
    buf.truncate(keep);
    let enc = encoding_rs::Encoding::for_label(norm_label(&encoding).as_bytes())
        .unwrap_or(encoding_rs::UTF_8);
    let (s, _, _) = enc.decode(&buf);
    Ok(s.into_owned())
}

/// 章节写回核心逻辑（命令包装 + 测试直接调用）
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
    // 规范化 EOL + 编码
    let normalized = crate::fs::normalize_eol(content, eol);
    let enc = encoding_rs::Encoding::for_label(norm_label(encoding).as_bytes())
        .unwrap_or(encoding_rs::UTF_8);
    let mut repl: Vec<u8> = Vec::new();
    if start == 0 && has_bom {
        repl.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    let (enc_bytes, _, had_errors) = enc.encode(&normalized);
    if had_errors {
        return Err(format!("文本包含 {encoding} 无法表示的字符，保存被取消"));
    }
    repl.extend_from_slice(&enc_bytes);
    // 拼接
    let (s, e) = (start as usize, (end as usize).min(bytes.len()));
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len() - (e - s) + repl.len());
    out.extend_from_slice(&bytes[..s.min(bytes.len())]);
    out.extend_from_slice(&repl);
    out.extend_from_slice(&bytes[e.min(bytes.len())..]);
    fs::write(path, &out).map_err(|e| io_err(e, "写入文件"))?;
    Ok(out.len() as u64)
}

/// 章节写回：读整文件 → 替换 [start, end) 字节段 → 原编码写回
#[tauri::command]
pub fn write_chapter(
    app: tauri::AppHandle,
    path: String,
    start: u64,
    end: u64,
    content: String,
    encoding: String,
    has_bom: bool,
    eol: String,
) -> Result<u64, String> {
    let size =
        write_chapter_impl(&path, start, end, &content, &encoding, has_bom, &eol)?;
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
        // end 衔接
        assert_eq!(ch[0].3, ch[1].2);
        assert_eq!(ch[1].3, ch[2].2);
    }

    #[test]
    fn volumes_and_specials() {
        let s = "第一卷 风起\n序章\n楔子\n第一章 开始\n故事从这里开始。\n第二章 结束\n尾声\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 6);
        assert_eq!(ch[0].0, "第一卷 风起");
        assert_eq!(ch[0].1, 1); // 卷 = level 1
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
        // 散文：无标准章节标题 → 不应判为小说
        let s = "今天天气很好，我出门散步。\n路上遇到了老朋友，他说要请我吃饭。\n我们聊了很久，回忆起当年的往事。\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 0);
    }

    #[test]
    fn long_line_not_heading() {
        // 长行（>96B）即使以"第一章"开头也不算标题
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
        // GBK 编码的中文章节
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
        assert_eq!(ch[1].2, ch[0].3); // end 衔接（\r\n 两字节偏移正确）
    }

    #[test]
    fn paren_numbers() {
        // 括号编号（网文常见）：全角/半角/方头括号
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
        // 行首数字 + 空格 + 标题（M8）
        let s = "3101 言\n内容\n3102 一人一龟\n内容\n3103 威尼斯商界峰会\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].0, "3101 言");
        assert_eq!(ch[1].0, "3102 一人一龟");
    }

    #[test]
    fn custom_regex_chapters() {
        // 自定义正则：匹配 "【xxx】" 形式
        let re = regex::Regex::new(r"^【.+】").unwrap();
        let s = "【001】序章\n内容\n【002】第一章\n内容\n【003】终章\n";
        let out = scan_bytes(s.as_bytes(), "UTF-8", false, Some(&re));
        assert_eq!(out.chapters.len(), 3);
        assert_eq!(out.chapters[0].title, "【001】序章");
        assert_eq!(out.chapters[2].title, "【003】终章");
        // 无匹配 → 空
        let re2 = regex::Regex::new(r"^第X章").unwrap();
        let out2 = scan_bytes(s.as_bytes(), "UTF-8", false, Some(&re2));
        assert_eq!(out2.chapters.len(), 0);
    }

    #[test]
    fn utf16_without_bom_detected() {
        // UTF-16LE 无 BOM 文本 → 启发式应检出 UTF-16 LE（样本需 ≥64 字节）
        let long =
            "第一章 测试，这是正文内容，用于编码检测验证。第二章 继续，更多正文内容。第三章 结束。\n";
        let mut u16bytes: Vec<u8> = Vec::new();
        for ch in long.encode_utf16() {
            u16bytes.extend_from_slice(&ch.to_le_bytes());
        }
        assert!(u16bytes.len() >= 64);
        let (enc, bom) = detect_encoding(&u16bytes);
        assert_eq!(enc, "UTF-16 LE");
        assert!(!bom);
    }

    #[test]
    fn gbk_fallback_detection() {
        // 纯 GBK 中文：detect 不应返回拉丁系（GBK 兜底生效）
        let (enc_bytes, _, _) = encoding_rs::GBK.encode(
            "第一章 测试，这是正文内容，用于编码检测验证。第二章 继续，更多正文内容。第三章 结束。\n",
        );
        let (enc, bom) = detect_encoding(&enc_bytes);
        assert_eq!(enc, "GBK", "GBK 中文不应被误判为拉丁系");
        assert!(!bom);
        // 英文文本不误判为 GBK
        let ascii = b"The quick brown fox jumps over the lazy dog. Hello world 123.\n".to_vec();
        assert!(!gbk_plausible(&ascii));
        let (enc2, _) = detect_encoding(&ascii);
        assert_eq!(enc2, "UTF-8");
    }

    #[test]
    fn prose_no_false_positive_extended() {
        // 散文行不应误判（含"（一）"开头的中文段落长度受限，但句子中含编号不误判）
        let s = "我们谈到（一）个话题，聊了很久。\n他说（2）年前的事，我记不清了。\n";
        let ch = scan(s);
        assert_eq!(ch.len(), 0);
        // "（一）"单独成行且超短才算；长行即使以"一、"开头也不判
        let s2 = "一、这是一段很长很长的正文叙述内容，超过了三十个字的限制所以不会被认为是章节标题。\n";
        let ch2 = scan(s2);
        assert_eq!(ch2.len(), 0);
    }

    /// 分页边界对齐：UTF-8 多字节字符被切段时不产生乱码
    #[test]
    fn trim_partial_utf8() {
        let text = "第一章 测试\n这是正文内容，包含中文。\n第二章\n";
        let bytes = text.as_bytes();
        // 在任意位置切断（含多字节字符中间）→ 前段截到边界，后段从边界续接，拼接还原原文
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

    /// 集成测试：UTF-8 fixture 全链路（扫描 → 按章读 → 写回 → 重扫）
    #[test]
    fn fixture_utf8_roundtrip() {
        let path = format!(
            "{}/../test-fixtures/test-novel.txt",
            env!("CARGO_MANIFEST_DIR")
        );
        let r = scan_chapters(path.clone(), None, None).unwrap();
        assert!(r.is_novel, "UTF-8 fixture 应判为小说");
        assert_eq!(r.encoding, "UTF-8");
        assert!(r.chapters.len() >= 3);
        assert_eq!(r.chapters[0].title, "第1章 测试章节标题");

        // 按章懒加载
        let c0 = &r.chapters[0];
        let text =
            read_chapter(path.clone(), c0.start, c0.end, r.encoding.clone()).unwrap();
        assert!(text.contains("第1章 测试章节标题"));
        assert!(text.contains("正文内容"));

        // 章写回（内容不变，尺寸应一致；EOL 为 LF 时无改写）
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

        // 重扫章节表一致
        let r2 = scan_chapters(path, None, None).unwrap();
        assert_eq!(r2.chapters.len(), r.chapters.len());
    }

    /// 集成测试：GBK fixture（编码检测 + 章节扫描 + 按章读回）
    #[test]
    fn fixture_gbk_novel() {
        let path = format!(
            "{}/../test-fixtures/test-novel-gbk.txt",
            env!("CARGO_MANIFEST_DIR")
        );
        let r = scan_chapters(path.clone(), None, None).unwrap();
        assert!(r.is_novel, "GBK fixture 应判为小说");
        assert_eq!(r.encoding, "GBK");
        assert_eq!(r.chapters[0].title, "第1章 测试章节标题");
        let c0 = &r.chapters[0];
        let text =
            read_chapter(path, c0.start, c0.end, r.encoding.clone()).unwrap();
        assert!(text.contains("正文内容"));
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
        // 生成 ~50MB：2000 章 × 每章 25KB 正文
        let mut s = String::with_capacity(50 * 1024 * 1024);
        for i in 1..=5200 {
            s.push_str(&format!("第{i}章 章节标题\n"));
            for _ in 0..100 {
                s.push_str("这是一段很长的正文内容，用于填充章节体积，模拟真实小说的段落文字。");
                s.push('\n');
            }
        }
        let bytes = s.as_bytes();
        eprintln!("size: {} MB, lines: {}", bytes.len() / 1024 / 1024, s.lines().count());
        let t0 = Instant::now();
        let out = scan_bytes(bytes, "UTF-8", false, None);
        let ms = t0.elapsed().as_millis();
        eprintln!("scan 50MB: {ms}ms, chapters: {}", out.chapters.len());
        assert_eq!(out.chapters.len(), 5200);
        assert!(ms < 1000, "50MB 扫描应 <1s，实际 {ms}ms");
    }
}
