//! 更新器前端逻辑（零新增依赖）—— 更新源为 GitHub Releases API：
//!   1) 调 `releases/latest` API（走 Rust curl，无 CORS）：拿最新 tag_name(版本) + 安装包 digest(SHA-256)
//!   2) 读取 Release 备注里的数字签名行 `sig: <base64>`，用内置公钥验签（version + sha256，R-06）
//!   3) 版本 > 当前 → 横幅/设置页提示「前往下载」，点击用系统浏览器打开 GitHub Release 页手动安装
//!
//! 不发布/依赖 latest.json，不做应用内下载、静默安装（安装改为去 Release 页手动）。

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { verifyUpdateManifest } from "./updateVerify";

/** 更新检查地址：GitHub Releases latest API（GitHub 自动维护，无需额外清单文件） */
export const UPDATE_API_URL =
	"https://api.github.com/repos/cttailearn/jianreader/releases/latest";

/** 兜底的 Release 页地址（API 未返回 html_url 时使用） */
export const RELEASE_PAGE_URL =
	"https://github.com/cttailearn/jianreader/releases/latest";

export interface UpdateInfo {
	/** 新版本号（如 0.3.1） */
	version: string;
	/** Release 页地址，点击后用系统浏览器打开，手动下载安装 */
	url: string;
	/** 安装包 SHA-256（小写 hex，来自 GitHub API digest，参与签名绑定） */
	sha256: string;
	/** 安装包字节数（可选） */
	size?: number;
	/** 更新说明（可选，来自 Release 备注，已去掉 sig 行） */
	notes?: string;
}

/** 简单语义化版本比较：>0 表示 a 更新，=0 相同，<0 a 更旧 */
export function compareVersions(a: string, b: string): number {
	const num = (s: string) => {
		const m = s.replace(/^v/i, "").match(/\d+/g);
		return (m ?? []).map((x) => parseInt(x, 10) || 0);
	};
	const pa = num(a);
	const pb = num(b);
	const n = Math.max(pa.length, pb.length, 3);
	for (let i = 0; i < n; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}

interface GitHubAsset {
	name?: string;
	size?: number;
	digest?: string;
	browser_download_url?: string;
}

interface GitHubRelease {
	tag_name?: string;
	html_url?: string;
	body?: string;
	assets?: GitHubAsset[];
}

/** 选择安装包资产：优先 `*-setup_<v>_x64-setup.exe`，其次任意非 portable 的 .exe */
function pickSetupAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
	return (
		assets.find(
			(a) =>
				/-setup_-?[0-9].*x64-setup\.exe$/i.test(a.name ?? "") &&
				!/portable/i.test(a.name ?? ""),
		) ??
		assets.find(
			(a) => /\.exe$/i.test(a.name ?? "") && !/portable/i.test(a.name ?? ""),
		)
	);
}

/** 从 Release 备注提取 `sig: <base64>` 行 */
function extractSig(body: string): string | undefined {
	const m = body.match(/(?:^|\n)[ \t]*sig:[ \t]*([A-Za-z0-9+/=]+)/);
	return m?.[1];
}

/** 去掉备注里的 sig 行（展示给用户的说明只用其余部分） */
function stripSigLine(body: string): string | undefined {
	const clean = body
		.replace(/(?:^|\n)[ \t]*sig:[ \t]*[A-Za-z0-9+/=]+/m, "")
		.trim();
	return clean || undefined;
}

/** 拉取并校验更新信息；解析/签名校验失败抛错，由调用方呈现 */
export async function fetchUpdateManifest(): Promise<UpdateInfo> {
	// 走 Rust curl（无 CORS、无需认证），返回 GitHub Releases API 文本
	const text = (await invoke<string>("download_text", {
		url: UPDATE_API_URL,
	})) as string;
	let j: GitHubRelease;
	try {
		j = JSON.parse(text) as GitHubRelease;
	} catch {
		throw new Error("更新信息读取失败（响应不是有效 JSON）");
	}
	const version = String(j.tag_name ?? "").replace(/^v/i, "");
	if (!version) throw new Error("更新信息读取失败（缺少版本号）");
	const asset = pickSetupAsset(j.assets ?? []);
	if (!asset) throw new Error("未在最新 Release 中找到安装包资产");
	const sha256 = String(asset.digest ?? "")
		.replace(/^sha256:/i, "")
		.toLowerCase();
	if (!sha256) {
		throw new Error("无法获取安装包 SHA-256（GitHub API 未返回 digest）");
	}
	const body = typeof j.body === "string" ? j.body : "";
	const sig = extractSig(body);
	if (!sig) {
		throw new Error(
			"该版本 Release 备注缺少数字签名（需含 `sig: …` 行）。请用 release.ps1 -Publish 重新发布（自动签名），或手动补签后重试。",
		);
	}
	// R-06：用内置公钥验签（version + sha256），通过后才信任该版本信息并提示更新
	await verifyUpdateManifest({ version, sha256, signature: sig });
	const url = String(j.html_url ?? RELEASE_PAGE_URL);
	const size = typeof asset.size === "number" ? asset.size : undefined;
	return { version, url, sha256, size, notes: stripSigLine(body) };
}

/** 检查是否有新版本；返回当前版本号 + 是否有可用更新 + 发布信息 */
export async function checkForUpdates(): Promise<{
	available: boolean;
	current: string;
	info: UpdateInfo | null;
}> {
	const info = await fetchUpdateManifest();
	const current = await getVersion();
	return { available: compareVersions(info.version, current) > 0, current, info };
}
