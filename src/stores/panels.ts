//! 左右面板宽度（可拖拽调宽，localStorage 记忆）

import { create } from "zustand";

const KEY = "jianyue-panels-v1";
const DEFAULT_LEFT = 260;
const DEFAULT_RIGHT = 240;
const MIN_W = 160;
const MAX_W = 520;

function load(side: "left" | "right", fallback: number): number {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) {
			const v = (JSON.parse(raw) as Record<string, number>)[side];
			if (typeof v === "number" && v >= MIN_W && v <= MAX_W) return v;
		}
	} catch {
		/* ignore */
	}
	return fallback;
}

function save(side: "left" | "right", w: number): void {
	try {
		const raw = localStorage.getItem(KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
		map[side] = w;
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		/* ignore */
	}
}

export const MIN_PANEL_W = MIN_W;
export const MAX_PANEL_W = MAX_W;

export const usePanelsStore = create<{
	leftW: number;
	rightW: number;
	setLeftW: (w: number) => void;
	setRightW: (w: number) => void;
}>((set) => ({
	leftW: load("left", DEFAULT_LEFT),
	rightW: load("right", DEFAULT_RIGHT),
	setLeftW: (leftW) => {
		save("left", leftW);
		set({ leftW });
	},
	setRightW: (rightW) => {
		save("right", rightW);
		set({ rightW });
	},
}));
