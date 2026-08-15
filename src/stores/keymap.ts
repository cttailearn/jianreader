//! 快捷键配置（M9）：动作 → 组合键字符串，可在设置面板中修改
//! 组合键格式：modifier+key（ctrl / shift / alt / ctrl+shift），如 "ctrl+s"、"ctrl+shift+t"

import { create } from "zustand";

export type KeyAction =
	| "save"
	| "openFolder"
	| "closeTab"
	| "toggleTheme"
	| "nextTab"
	| "findInReader";

export const KEY_ACTION_LABELS: Record<KeyAction, string> = {
	save: "保存",
	openFolder: "打开目录",
	closeTab: "关闭标签",
	toggleTheme: "切换主题",
	nextTab: "下一个标签",
	findInReader: "阅读模式查找",
};

export const DEFAULT_KEYMAP: Record<KeyAction, string> = {
	save: "ctrl+s",
	openFolder: "ctrl+o",
	closeTab: "ctrl+w",
	toggleTheme: "ctrl+shift+t",
	nextTab: "ctrl+tab",
	findInReader: "ctrl+f",
};

const KEY = "jianyue-keymap-v1";

function load(): Record<KeyAction, string> {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) {
			const m = JSON.parse(raw) as Partial<Record<KeyAction, string>>;
			return { ...DEFAULT_KEYMAP, ...m };
		}
	} catch {
		/* ignore */
	}
	return { ...DEFAULT_KEYMAP };
}

/** 组合键字符串 → 规范化（去空格小写，排序修饰符） */
function normalize(combo: string): string {
	const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
	const mods = parts.filter((p) => ["ctrl", "shift", "alt"].includes(p));
	const key = parts.filter((p) => !["ctrl", "shift", "alt"].includes(p));
	if (key.length !== 1) return "";
	const order = ["ctrl", "alt", "shift"];
	mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
	return [...mods, key[0]].join("+");
}

/** 键盘事件是否匹配组合键 */
export function matchKey(e: KeyboardEvent, combo: string): boolean {
	const parts = normalize(combo).split("+");
	if (parts.length === 0) return false;
	const key = parts[parts.length - 1];
	const ctrl = parts.includes("ctrl");
	const shift = parts.includes("shift");
	const alt = parts.includes("alt");
	if (e.ctrlKey !== ctrl || e.shiftKey !== shift || e.altKey !== alt) return false;
	const k = e.key.toLowerCase();
	if (key === "tab") return k === "tab";
	if (key === "space") return k === " ";
	return k === key;
}

/** 事件 → 组合键字符串（录制用） */
export function eventToCombo(e: KeyboardEvent): string {
	const parts: string[] = [];
	if (e.ctrlKey) parts.push("ctrl");
	if (e.altKey) parts.push("alt");
	if (e.shiftKey) parts.push("shift");
	const k = e.key.toLowerCase();
	if (["control", "alt", "shift", "meta"].includes(k)) return "";
	if (k === " ") return "space";
	parts.push(k);
	return parts.join("+");
}

export const useKeymapStore = create<{
	keymap: Record<KeyAction, string>;
	/** 设置某动作快捷键；与其它动作冲突或非法返回 false */
	setKey: (action: KeyAction, combo: string) => boolean;
	reset: () => void;
}>((set, get) => ({
	keymap: load(),
	setKey: (action, combo) => {
		const norm = normalize(combo);
		if (!norm) return false;
		// 冲突检测：其它动作已占用同组合键 → 拒绝
		for (const [a, c] of Object.entries(get().keymap) as [KeyAction, string][]) {
			if (a !== action && normalize(c) === norm) return false;
		}
		const keymap = { ...get().keymap, [action]: norm };
		try {
			localStorage.setItem(KEY, JSON.stringify(keymap));
		} catch {
			/* ignore */
		}
		set({ keymap });
		return true;
	},
	reset: () => {
		const keymap = { ...DEFAULT_KEYMAP };
		try {
			localStorage.setItem(KEY, JSON.stringify(keymap));
		} catch {
			/* ignore */
		}
		set({ keymap });
	},
}));
