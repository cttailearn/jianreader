import { create } from "zustand";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "tve-theme";

function loadInitial(): ThemeMode {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "light" || saved === "dark") return saved;
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
