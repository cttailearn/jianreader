//! 应用设置（M9）：自动保存 / 显示隐藏文件 / 大文件语法高亮
//! localStorage 持久化；主题走 theme.ts，快捷键走 keymap.ts

import { create } from "zustand";

const KEY = "jianyue-settings-v1";

export interface AppSettings {
	/** 自动保存：dirty 后 2s 自动写盘（默认关） */
	autoSave: boolean;
	/** 显示隐藏文件与噪音目录（.git/node_modules/dist 等，默认关） */
	showHidden: boolean;
	/** 大文件（>3MB）加载语法高亮（默认关：更快） */
	largeFileHighlight: boolean;
	/** 启动时自动检查更新（默认开） */
	autoCheckUpdate: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
	autoSave: false,
	showHidden: false,
	largeFileHighlight: false,
	autoCheckUpdate: true,
};

function load(): AppSettings {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
	} catch {
		/* ignore */
	}
	return { ...DEFAULT_SETTINGS };
}

export const useSettingsStore = create<{
	settings: AppSettings;
	set: (patch: Partial<AppSettings>) => void;
	/** 设置面板开合（TopBar 齿轮 / SettingsPanel 自身控制） */
	panelOpen: boolean;
	setPanelOpen: (open: boolean) => void;
}>((set) => ({
	settings: load(),
	panelOpen: false,
	set: (patch) =>
		set((s) => {
			const next = { ...s.settings, ...patch };
			try {
				localStorage.setItem(KEY, JSON.stringify(next));
			} catch {
				/* ignore */
			}
			return { settings: next };
		}),
	setPanelOpen: (panelOpen) => set({ panelOpen }),
}));
