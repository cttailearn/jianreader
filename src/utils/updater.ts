//! 更新器前端逻辑（零新增依赖）：
//!   1) 拉取 GitHub Releases 的 latest.json 清单（版本/下载地址/大小/SHA-256）
//!   2) 下载安装包（实时进度）→ 磁盘 SHA-256 校验
//!   3) 触发静默安装并退出应用
//!
//! 网络请求全部交给 Rust 侧用 curl 完成（Rust 无 CORS 限制），避开 GitHub 下载
//! CDN 对浏览器跨域 fetch 不加 Access-Control-Allow-Origin 的问题。

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

/** 更新清单地址：每次 GitHub Release 都上传 latest.json 资产，经 releases/latest 固定取最新 */
export const UPDATE_MANIFEST_URL =
	"https://github.com/cttailearn/jianreader/releases/latest/download/latest.json";

export interface UpdateInfo {
	/** 新版本号（如 0.3.0） */
	version: string;
	/** 安装包直链 */
	url: string;
	/** 安装包 SHA-256（小写 hex） */
	sha256: string;
	/** 安装包字节数（可选，用于下载进度条） */
	size?: number;
	/** 更新说明（可选） */
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

/** 拉取更新清单；解析失败抛错，由调用方呈现 */
export async function fetchUpdateManifest(): Promise<UpdateInfo> {
	// 走 Rust curl（无 CORS），返回 latest.json 文本
	const text = (await invoke<string>("download_text", {
		url: UPDATE_MANIFEST_URL,
	})) as string;
	let j: Partial<UpdateInfo>;
	try {
		j = JSON.parse(text) as Partial<UpdateInfo>;
	} catch {
		throw new Error("更新清单格式无效");
	}
	if (!j.version || !j.url || !j.sha256) {
		throw new Error("更新清单格式无效");
	}
	return {
		version: String(j.version),
		url: String(j.url),
		sha256: String(j.sha256).toLowerCase(),
		size: typeof j.size === "number" ? j.size : undefined,
		notes: typeof j.notes === "string" ? j.notes : undefined,
	};
}

/** 检查是否有新版本；返回当前版本号 + 是否有可用更新 + 清单信息 */
export async function checkForUpdates(): Promise<{
	available: boolean;
	current: string;
	info: UpdateInfo | null;
}> {
	const info = await fetchUpdateManifest();
	const current = await getVersion();
	return { available: compareVersions(info.version, current) > 0, current, info };
}

/**
 * 下载并安装新版本：Rust 侧 curl 下载 → 磁盘 SHA-256 校验 → 触发静默安装（应用随后退出）。
 * @param onPhase 阶段回调：downloading 下载 / verifying 校验 / installing 触发安装
 * @param onProgress downloaded 字节数 / total 字节数（total 为 0 表示未知，供不确定进度）
 */
export async function downloadAndInstall(
	info: UpdateInfo,
	onPhase: (phase: "downloading" | "verifying" | "installing") => void,
	onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
	onPhase("downloading");

	// 1) 文件目标
	const dir = (await invoke<string>("prepare_update_dir")) as string;
	const destPath = `${dir}\\jianreader-setup_${info.version}.exe`;

	// 2) Rust 下载（无 CORS）；同时轮询落盘大小驱动进度条
	let timer: ReturnType<typeof setInterval> | undefined;
	if (info.size && info.size > 0) {
		timer = setInterval(() => {
			const total = info.size ?? 0;
			invoke<[number, boolean]>("file_meta", { path: destPath })
				.then(([sz]) => onProgress(Math.min(sz, total), total))
				.catch(() => {
					/* 文件尚未出现，忽略 */
				});
		}, 600);
	}
	try {
		await invoke("download_file", { url: info.url, dest: destPath });
	} finally {
		if (timer) clearInterval(timer);
	}
	onProgress(info.size ?? 0, info.size ?? 0);

	// 3) 磁盘级 SHA-256 校验（Rust 走 PowerShell，不依赖 webcrypto 环境）
	onPhase("verifying");
	const diskHash = (await invoke<string>("sha256_file", { path: destPath })) as string;
	if (diskHash !== info.sha256) {
		// 清掉坏文件
		await invoke("delete_path", { path: destPath }).catch(() => {});
		throw new Error("安装包下载后校验失败（SHA-256 不匹配），已中止");
	}

	// 4) 触发静默安装（内部等待后退出本进程；正常情况调用不会正常返回）
	onPhase("installing");
	await invoke("install_update", { path: destPath });
}
