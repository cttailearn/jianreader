//! 应用设置（M9）：自动保存 / 显示隐藏文件 / 大文件语法高亮 / 文本字号与字体
//! localStorage 持久化；主题走 theme.ts，快捷键走 keymap.ts

import { create } from "zustand";

const KEY = "jianyue-settings-v1";

/** 可选的正文/小说字体（id 存 settings.editorFontFamily；family 列为 CSS 字体栈） */
export const FONT_FAMILY_OPTIONS: {
	id: string;
	label: string;
	/** CSS font-family 栈；null = 系统默认（各区域各自默认字体） */
	family: string | null;
}[] = [
	{ id: "system", label: "系统默认", family: null },
	{
		id: "yahei",
		label: "微软雅黑",
		family: `"Microsoft YaHei", "PingFang SC", "Source Han Sans SC", sans-serif`,
	},
	{
		id: "song",
		label: "宋体",
		family: `SimSun, "Songti SC", "Noto Serif CJK SC", serif`,
	},
	{
		id: "kaiti",
		label: "楷体",
		family: `KaiTi, "Kaiti SC", "STKaiti", serif`,
	},
	{
		id: "fangsong",
		label: "仿宋",
		family: `"FangSong", "FangSong_GB2312", "STFangsong", serif`,
	},
	{
		id: "hei",
		label: "黑体",
		family: `SimHei, "Heiti SC", "Microsoft YaHei", sans-serif`,
	},
	{
		id: "dengxian",
		label: "等线",
		family: `"DengXian", "Microsoft YaHei", sans-serif`,
	},
	{
		id: "youyuan",
		label: "幼圆",
		family: `"YouYuan", "Yuanti SC", sans-serif`,
	},
];

export interface AppSettings {
	/** 自动保存：dirty 后 2s 自动写盘（默认关） */
	autoSave: boolean;
	/** 显示隐藏文件与噪音目录（.git/node_modules/dist 等，默认关） */
	showHidden: boolean;
	/** 大文件（>3MB）加载语法高亮（默认关：更快） */
	largeFileHighlight: boolean;
	/** 启动时自动检查更新（默认开） */
	autoCheckUpdate: boolean;
	/** 正文字号（px）：代码编辑器 + Markdown 正文，12~24 */
	editorFontSize: number;
	/** 正文字体 id：见 FONT_FAMILY_OPTIONS（Markdown 正文 + 小说阅读文字） */
	editorFontFamily: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
	autoSave: false,
	showHidden: false,
	largeFileHighlight: false,
	autoCheckUpdate: true,
	editorFontSize: 15.5,
	editorFontFamily: "system",
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
