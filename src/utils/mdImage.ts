//! MD 本地图片：相对路径 ↔ asset 协议 URL 双向转换
//! 编辑器内渲染用 convertFileSrc（WebView 安全策略禁 file://），
//! 保存回磁盘前还原为相对路径，不污染文档数据。

import { convertFileSrc } from "@tauri-apps/api/core";

const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** 取文件所在目录（Windows 反斜杠） */
export function dirnameOf(path: string): string {
	return path.replace(/[\\/][^\\/]*$/, "");
}

/** 绝对路径 → 相对（同一磁盘用 ../ 相对；跨盘保持绝对路径） */
function toRelative(abs: string, dir: string): string {
	const norm = (p: string) => p.replace(/\//g, "\\");
	const a = norm(abs);
	const d = norm(dir);
	if (a.toLowerCase().startsWith(d.toLowerCase())) {
		return a.slice(d.length).replace(/^\\/, "").replace(/\\/g, "/");
	}
	// 跨盘或不在目录下：返回绝对路径（markdown 仍可识别）
	return a.replace(/\\/g, "/");
}

/** 加载：相对路径图片 → asset URL（渲染用） */
export function resolveMarkdownImages(md: string, dir: string): string {
	return md.replace(IMG_RE, (m, alt, src) => {
		if (/^(https?:|data:|asset:|\/|#|[a-zA-Z]:[\\/])/.test(src)) {
			return m; // 网络图 / 已转换 / 根路径 / 锚点 / 绝对路径不动
		}
		const abs = dir + "\\" + src.replace(/\//g, "\\");
		return `![${alt}](${convertFileSrc(abs)})`;
	});
}

/** 保存：asset URL → 相对路径还原 */
export function unresolveMarkdownImages(md: string, dir: string): string {
	return md.replace(/http:\/\/asset\.localhost\/([^)\s]+)/g, (_m, encoded) => {
		try {
			const abs = decodeURIComponent(encoded);
			return toRelative(abs, dir);
		} catch {
			return _m;
		}
	});
}

/** 判断路径是否为 MD 文件 */
export function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(path);
}

/** 表格行判定：去行首转义后以 | 开头且 ≥3 列（≥2 个管道符） */
function isTableRow(line: string): boolean {
	const c = line.replace(/^\\\|/, "|").trimStart();
	return /^\|.*\|.*\|/.test(c) && (c.match(/\|/g)?.length ?? 0) >= 2;
}

/** 表头分隔行判定：| --- | :--: | 等 */
function isSeparatorRow(line: string): boolean {
	const c = line.trim();
	return c.includes("-") && /^\|?[\s:|-]+\|?\s*$/.test(c);
}

/**
 * 修复"管道表格未渲染"（M8）：
 * - 无表头分隔行的表格（导出工具常见）→ 自动补分隔行（首行为表头）
 * - 行首 `\|` 转义误用 → 去除转义
 * 仅处理连续 ≥2 行的表格块，单行不转换（防误判）；
 * 幂等：已是合法表格的输入不变。
 */
export function normalizeTables(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (!isTableRow(lines[i])) {
			out.push(lines[i]);
			i++;
			continue;
		}
		// 收集连续表格行块（含分隔行）
		const block: string[] = [];
		while (i < lines.length && (isTableRow(lines[i]) || isSeparatorRow(lines[i]))) {
			block.push(lines[i]);
			i++;
		}
		if (block.length < 2) {
			out.push(...block);
			continue;
		}
		const norm = block.map((l) => l.replace(/^\\\|/, "|"));
		const hasSep = norm.length >= 2 && isSeparatorRow(norm[1]);
		if (!hasSep) {
			const cols = Math.max(1, (norm[0].match(/\|/g)?.length ?? 1) - 1);
			const sep = "|" + Array(cols).fill(" --- ").join("|") + "|";
			out.push(norm[0], sep, ...norm.slice(1));
		} else {
			out.push(...norm);
		}
	}
	return out.join("\n");
}
