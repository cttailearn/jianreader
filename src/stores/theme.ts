import { create } from "zustand";

export type ThemeMode = "light" | "dark";

// R-27：localStorage 键统一 jianyue-* 命名空间；兼容迁移旧键 tve-theme
const LEGACY_STORAGE_KEY = "tve-theme";
const STORAGE_KEY = "jianyue-theme";

function loadInitial(): ThemeMode {
	try {
		const saved =
			localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
		if (saved === "light" || saved === "dark") {
			// 迁移：把旧键值写入新键
			if (!localStorage.getItem(STORAGE_KEY)) {
				localStorage.setItem(STORAGE_KEY, saved);
			}
			return saved;
		}
	} catch {
		/* localStorage 不可用时回退默认 */
	}
	return "light";
}

interface ThemeState {
	mode: ThemeMode;
	toggle: () => void;
	set: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
	mode: loadInitial(),
	toggle: () => {
		const next: ThemeMode = get().mode === "light" ? "dark" : "light";
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			/* ignore */
		}
		set({ mode: next });
	},
	set: (mode) => {
		try {
			localStorage.setItem(STORAGE_KEY, mode);
		} catch {
			/* ignore */
		}
		set({ mode });
	},
}));
