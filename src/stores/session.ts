//! 会话恢复（M6）：记住上次目录 / 标签列表 / 激活标签 / 窗口位置，重启还原
//! - 标签只记路径，重启后逐个 openFile（小说标签自动回到小说模式 + 续读书签）
//! - 窗口位置做多显示器可见性校验，避免恢复到屏幕外

import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

const SESSION_KEY = "jianyue-session-v1";
const WINDOW_KEY = "jianyue-window-v1";

export interface Session {
	root: string | null;
	tabs: string[];
	active: string | null;
}

export function loadSession(): Session | null {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		return raw ? (JSON.parse(raw) as Session) : null;
	} catch {
		return null;
	}
}

export function saveSession(s: Session): void {
	try {
		localStorage.setItem(SESSION_KEY, JSON.stringify(s));
	} catch {
		/* ignore */
	}
}

export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
	maximized: boolean;
}

export async function saveWindowBounds(): Promise<void> {
	try {
		const win = getCurrentWindow();
		const [pos, size, maximized] = await Promise.all([
			win.outerPosition(),
			win.outerSize(),
			win.isMaximized(),
		]);
		localStorage.setItem(
			WINDOW_KEY,
			JSON.stringify({
				x: pos.x,
				y: pos.y,
				width: size.width,
				height: size.height,
				maximized,
			} as WindowBounds),
		);
	} catch {
		/* ignore */
	}
}

export async function restoreWindowBounds(): Promise<void> {
	try {
		const raw = localStorage.getItem(WINDOW_KEY);
		if (!raw) return;
		const b = JSON.parse(raw) as WindowBounds;
		if (!b.width || !b.height) return;
		// 多显示器可见性校验：窗口矩形需与任一显示器相交，否则丢弃（显示器已被拔掉）
		const monitors = await availableMonitors();
		const visible = monitors.some((m) => {
			const x1 = Math.max(b.x, m.position.x);
			const y1 = Math.max(b.y, m.position.y);
			const x2 = Math.min(b.x + b.width, m.position.x + m.size.width);
			const y2 = Math.min(b.y + b.height, m.position.y + m.size.height);
			return x2 - x1 >= 80 && y2 - y1 >= 60; // 至少露出 80x60
		});
		if (!visible) return;
		const win = getCurrentWindow();
		await win.setPosition(new PhysicalPosition(b.x, b.y));
		await win.setSize(new PhysicalSize(b.width, b.height));
		if (b.maximized) await win.maximize();
	} catch {
		/* ignore */
	}
}
