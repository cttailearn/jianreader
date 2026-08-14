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
