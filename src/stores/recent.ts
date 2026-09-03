//! 最近打开的目录（M10）：记录打开过的根目录，顶栏下拉快速选择
//! localStorage 持久化；最新在前，去重，上限 10 条
//! R-27：键统一 jianyue-*，兼容迁移旧键 tve-recent

import { create } from "zustand";

const LEGACY_KEY = "tve-recent";
const KEY = "jianyue-recent";
export const RECENT_MAX = 10;

function load(): string[] {
	try {
		const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
		if (raw) {
			const arr = JSON.parse(raw) as string[];
			if (Array.isArray(arr)) {
				const list = arr.filter((p) => typeof p === "string");
				if (!localStorage.getItem(KEY) && LEGACY_KEY && localHas(LEGACY_KEY)) {
					localStorage.setItem(KEY, JSON.stringify(list));
				}
				return list;
			}
		}
	} catch {
		/* ignore */
	}
	return [];
}

function localHas(k: string): boolean {
	try {
		return localStorage.getItem(k) !== null;
	} catch {
		return false;
	}
}

function persist(list: string[]): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(list));
	} catch {
		/* ignore */
	}
}

export const useRecentStore = create<{
	recent: string[];
	/** 打开目录成功后调用：去重、移到最前、截断上限 */
	record: (path: string) => void;
	/** 从列表移除（目录已不可用/清除单条） */
	remove: (path: string) => void;
	/** 清空全部记录 */
	clear: () => void;
}>((set) => ({
	recent: load(),
	record: (path) =>
		set((s) => {
			const next = [path, ...s.recent.filter((p) => p !== path)].slice(
				0,
				RECENT_MAX,
			);
			persist(next);
			return { recent: next };
		}),
	remove: (path) =>
		set((s) => {
			const next = s.recent.filter((p) => p !== path);
			persist(next);
			return { recent: next };
		}),
	clear: () => {
		persist([]);
		set({ recent: [] });
	},
}));
