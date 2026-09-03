//! 更新器状态：检查 / 可用（点击前往 Release 页手动安装）/ 最新 / 错误，以及启动自动检查横幅
//! 持久化开关（autoCheckUpdate）在 settings.ts，这里只读引用

import { create } from "zustand";
import { checkForUpdates, type UpdateInfo } from "../utils/updater";
import { useSettingsStore } from "./settings";

export type UpdaterStatus =
	| "idle" // 未检查
	| "checking" // 正在检查
	| "upToDate" // 已是最新
	| "available" // 发现新版本
	| "error"; // 检查失败

interface UpdaterStore {
	status: UpdaterStatus;
	info: UpdateInfo | null;
	currentVersion: string | null;
	error: string | null;
	lastChecked: number | null;
	/** 启动自动检查发现新版本时置 true（用于右下角横幅），手动检查不弹横幅 */
	banner: boolean;

	setStatus: (status: UpdaterStatus) => void;
	/** auto=true 表示启动自动检查（发现新版本时弹横幅） */
	checkNow: (auto?: boolean) => Promise<void>;
	/** 用系统浏览器打开 Release 页，用户手动下载安装 */
	openRelease: () => Promise<void>;
	dismissBanner: () => void;
	dismissError: () => void;
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
	status: "idle",
	info: null,
	currentVersion: null,
	error: null,
	lastChecked: null,
	banner: false,

	setStatus: (status) => set({ status }),

	async checkNow(auto = false) {
		const s = get();
		if (s.status === "checking") return;
		if (auto && !useSettingsStore.getState().settings.autoCheckUpdate) return;
		set({ status: "checking", error: null, banner: false });
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

	async openRelease() {
		const url = get().info?.url;
		if (!url) return;
		const { openUrl } = await import("@tauri-apps/plugin-opener");
		try {
			await openUrl(url);
		} catch (e) {
			set({ status: "error", error: `打开下载页失败: ${String(e)}` });
		}
	},

	dismissBanner: () => set({ banner: false }),
	dismissError: () => set({ error: null, status: "idle" }),
}));
