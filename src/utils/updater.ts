//! 更新器前端逻辑（零后端新增依赖）：
//!   1) 从 GitHub Releases 拉取 latest.json 清单（版本/下载地址/SHA-256）
//!   2) 下载安装包（带进度）→ WebCrypto 校验 SHA-256
//!   3) base64 分块写盘（Rust）→ 触发静默安装并退出应用
//!
//! 下载/TLS 由 WebView2（自带 BoringSSL）完成，绕开系统 schannel 不可用问题。

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
	/** 更新说明（可选） */
	notes?: string;
}

/** 每次 IPC 写入的字节数（base64 后约 1.4 倍，控制在 ~700KB/次） */
const CHUNK_BYTES = 512 * 1024;

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

async function fetchJson(url: string, timeoutMs = 12_000): Promise<unknown> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	let res: Response;
	try {
		res = await fetch(url, { signal: ctrl.signal });
	} catch (e) {
		const reason = (e as Error)?.message ?? String(e);
		throw new Error(`网络错误（无法连接更新服务器）: ${reason}`);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) throw new Error(`检查更新失败（HTTP ${res.status}）`);
	return res.json();
}

/** 拉取更新清单；解析失败抛错，由调用方呈现 */
export async function fetchUpdateManifest(): Promise<UpdateInfo> {
	const j = (await fetchJson(UPDATE_MANIFEST_URL)) as Partial<UpdateInfo>;
	if (!j.version || !j.url || !j.sha256) {
		throw new Error("更新清单格式无效");
	}
	return {
		version: String(j.version),
		url: String(j.url),
		sha256: String(j.sha256).toLowerCase(),
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

/** WebCrypto SHA-256 → 小写 hex */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", data);
	const arr = new Uint8Array(buf);
	let hex = "";
	for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
	return hex;
}

function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		bin += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(bin);
}

/** 流式读取响应为 ArrayBuffer，边读边回调进度 */
async function readStream(
	res: Response,
	onProgress: (downloaded: number) => void,
): Promise<ArrayBuffer> {
	const reader = res.body?.getReader();
	if (!reader) return res.arrayBuffer();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			received += value.byteLength;
			onProgress(received);
		}
	}
	const out = new Uint8Array(received);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return out.buffer;
}

/**
 * 下载并安装新版本：下载 → SHA-256 校验（内存 + 磁盘双重）→ base64 分块写盘 → 触发静默安装（应用随后退出）。
 * @param onPhase 阶段回调：downloading 下载 / verifying 校验 / installing 触发安装
 * @param onProgress downloaded 字节数 / total 字节数（total 为 0 表示未知，供不确定进度）
 */
export async function downloadAndInstall(
	info: UpdateInfo,
	onPhase: (phase: "downloading" | "verifying" | "installing") => void,
	onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
	onPhase("downloading");

	// 1) 下载
	let res: Response;
	try {
		res = await fetch(info.url);
	} catch (e) {
		throw new Error(`下载失败（网络错误）: ${String((e as Error)?.message ?? e)}`);
	}
	if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
	const total = Number(res.headers.get("content-length")) || 0;
	const buf = await readStream(res, (dl) => onProgress(dl, total));
	onProgress(buf.byteLength, total);

	// 2) 内存级 SHA-256 校验（WebCrypto；secure context 可用时先行拦截坏包）
	if (globalThis.crypto?.subtle) {
		onPhase("verifying");
		const got = await sha256Hex(buf);
		if (got !== info.sha256) {
			throw new Error("安装包校验失败（SHA-256 不匹配），已中止");
		}
	}

	// 3) base64 分块写盘
	onPhase("verifying");
	const dir = (await invoke<string>("prepare_update_dir")) as string;
	const destPath = `${dir}\\jianreader-setup_${info.version}.exe`;
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
		const part = bytes.subarray(i, Math.min(i + CHUNK_BYTES, bytes.length));
		await invoke("write_update_chunk", {
			path: destPath,
			b64: bytesToBase64(part),
			append: i > 0,
		});
		onProgress(Math.min(i + CHUNK_BYTES, bytes.length), bytes.length);
	}

	// 4) 磁盘级 SHA-256 校验（Rust 走 PowerShell，不依赖 webcrypto 环境）
	const diskHash = (await invoke<string>("sha256_file", { path: destPath })) as string;
	if (diskHash !== info.sha256) {
		// 清掉坏文件
		await invoke("delete_path", { path: destPath }).catch(() => {});
		throw new Error("安装包写盘后校验失败（SHA-256 不匹配），已中止");
	}

	// 5) 触发静默安装（内部等待后退出本进程；正常情况调用不会正常返回）
	onPhase("installing");
	await invoke("install_update", { path: destPath });
}
