//! UI 琐碎状态：编辑器光标位置（状态栏显示）

import { create } from "zustand";

interface CursorState {
	line: number;
	col: number;
	set: (line: number, col: number) => void;
}

export const useCursorStore = create<CursorState>((set) => ({
	line: 1,
	col: 1,
	set: (line, col) => set({ line, col }),
}));
