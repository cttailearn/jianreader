//! 更新器状态：检查 / 可用 / 下载进度 / 安装，以及启动自动检查是否发现新版本（横幅提示）
//! 持久化开关（autoCheckUpdate）在 settings.ts，这里只读引用

import { create } from "zustand";
import {
	checkForUpdates,
	downloadAndInstall,
	type UpdateInfo,
} from "../utils/updater";
import { useSettingsStore } from "./settings";

export type UpdaterStatus =
	| "idle" // 未检查
	| "checking" // 正在检查
	| "upToDate" // 已是最新
	| "available" // 发现新版本
	| "error" // 检查/下载失败
	| "downloading" // 下载中
	| "verifying" // SHA-256 校验 + 写盘
	| "installing"; // 已触发安装，应用即将退出

interface UpdaterStore {
	status: UpdaterStatus;
	info: UpdateInfo | null;
	currentVersion: string | null;
	/** 0..1 下载/写盘进度 */
	progress: number;
	downloaded: number;
	total: number;
	error: string | null;
	lastChecked: number | null;
	/** 启动自动检查发现新版本时置 true（用于右下角横幅），手动检查不弹横幅 */
	banner: boolean;

	setStatus: (status: UpdaterStatus) => void;
	/** auto=true 表示启动自动检查（发现新版本时弹横幅） */
	checkNow: (auto?: boolean) => Promise<void>;
	startDownload: () => Promise<void>;
	dismissBanner: () => void;
	dismissError: () => void;
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
	status: "idle",
	info: null,
	currentVersion: null,
	progress: 0,
	downloaded: 0,
	total: 0,
	error: null,
	lastChecked: null,
	banner: false,

	setStatus: (status) => set({ status }),

	async checkNow(auto = false) {
		const s = get();
		if (s.status === "checking" || s.status === "downloading" || s.status === "installing") {
			return;
		}
		if (auto && !useSettingsStore.getState().settings.autoCheckUpdate) return;
		set({ status: "checking", error: null, progress: 0, downloaded: 0, total: 0, banner: false });
		try {
			const { available, current, info } = await checkForUpdates();
			set({
				currentVersion: current,
				info: available ? info : null,
				status: available ? "available" : "upToDate",
				lastChecked: Date.now(),
				banner: auto && available,
			});
		} catch (e) {
			set({
				status: "error",
				error: (e as Error).message,
				lastChecked: Date.now(),
				banner: false,
			});
		}
	},

	async startDownload() {
		const { info, status } = get();
		if (!info) return;
		if (status === "downloading" || status === "verifying" || status === "installing") return;
		set({
			status: "downloading",
			error: null,
			progress: 0,
			downloaded: 0,
			total: 0,
			banner: false,
		});
		try {
			await downloadAndInstall(
				info,
				(phase) => {
					if (phase === "verifying") {
						set({ downloaded: get().total, progress: 1, status: "verifying" });
					} else if (phase === "installing") {
						set({ status: "installing" });
					}
				},
				(downloaded, total) => {
					set({
						downloaded,
						total,
						progress: total > 0 ? Math.min(1, downloaded / total) : 0,
					});
				},
			);
		} catch (e) {
			set({ status: "error", error: (e as Error).message });
		}
	},

	dismissBanner: () => set({ banner: false }),
	dismissError: () => set({ error: null, status: "idle" }),
}));
