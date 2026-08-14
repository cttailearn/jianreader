//! 标签页/文档状态机（design.md 3.6）
//! closed → loading → ready → dirty → (saving) → ready
//! ready + 外部修改 → 自动重载（rev+1 重建编辑器）
//! dirty + 外部修改 → external-changed（提示条）
//! 磁盘删除 → deleted（保存可重建）

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getLanguage } from "../utils/language";

export type DocStatus =
	| "loading"
	| "ready"
	| "dirty"
	| "saving"
	| "external-changed"
	| "deleted"
	| "error";

export interface TabDoc {
	path: string;
	name: string;
	content: string;
	encoding: string;
	hasBom: boolean;
	eol: string;
	languageName: string; // 显示名（"Plain Text" / "TypeScript"...）
	size: number;
	status: DocStatus;
	/** 内容代际：外部重载后 +1，编辑器 key 随之重建 */
	rev: number;
	lastError?: string;
}

interface FilePayload {
	content: string;
	encoding: string;
	has_bom: boolean;
	eol: string;
	size: number;
}

function payloadToDoc(
	t: TabDoc,
	p: FilePayload,
	status: DocStatus = "ready",
): TabDoc {
	return {
		...t,
		content: p.content,
		encoding: p.encoding,
		hasBom: p.has_bom,
		eol: p.eol,
		size: p.size,
		status,
		rev: t.rev + 1,
		lastError: undefined,
	};
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

interface TabsState {
	tabs: TabDoc[];
	activePath: string | null;
	/** 打开文件（已打开则激活；带编码检测） */
	openFile: (path: string) => Promise<void>;
	activate: (path: string) => void;
	/** 关闭标签；dirty 时返回 false 表示被用户取消 */
	close: (path: string) => Promise<boolean>;
	/** 编辑器内容变更（自动标记 dirty；external-changed 保持提示态） */
	updateContent: (path: string, content: string) => void;
	save: (path: string) => Promise<boolean>;
	saveAll: () => Promise<void>;
	/** 外部修改且本地未改：重新读盘（rev+1） */
	reload: (path: string) => Promise<void>;
	/** 外部修改且本地已改：用户选择保留本地 → 回到 dirty */
	keepLocal: (path: string) => void;
	/** 外部修改且本地已改：标记提示态 */
	markExternalChanged: (path: string) => void;
	/** 磁盘删除：标记（dirty 内容保留，保存可重建） */
	markDeleted: (path: string) => void;
	/** 文件/目录改名：更新标签路径 */
	renameTab: (fromPath: string, toPath: string) => void;
}

export const useTabsStore = create<TabsState>((set, get) => ({
	tabs: [],
	activePath: null,

	openFile: async (path) => {
		const existing = get().tabs.find((t) => t.path === path);
		if (existing) {
			set({ activePath: path });
			return;
		}
		const lang = getLanguage(path);
		const doc: TabDoc = {
			path,
			name: basename(path),
			content: "",
			encoding: "UTF-8",
			hasBom: false,
			eol: "\n",
			languageName: lang?.name ?? "Plain Text",
			size: 0,
			status: "loading",
			rev: 0,
		};
		set((s) => ({ tabs: [...s.tabs, doc], activePath: path }));
		try {
			const p = await invoke<FilePayload>("read_text_file", { path });
			set((s) => ({
				tabs: s.tabs.map((t) => (t.path === path ? payloadToDoc(t, p) : t)),
			}));
		} catch (e) {
			set((s) => ({
				tabs: s.tabs.map((t) =>
					t.path === path ? { ...t, status: "error", lastError: String(e) } : t,
				),
			}));
		}
	},

	activate: (path) => set({ activePath: path }),

	close: async (path) => {
		const doc = get().tabs.find((t) => t.path === path);
		if (!doc) return true;
		if (doc.status === "dirty" || doc.status === "external-changed") {
			const { showDialog } = await import("./dialog");
			const r = await showDialog({
				title: "未保存的更改",
				message: `「${doc.name}」已修改，是否保存？`,
				buttons: [
					{ id: "save", label: "保存", danger: false },
					{ id: "discard", label: "不保存", danger: true },
					{ id: "cancel", label: "取消", danger: false },
				],
			});
			if (r.button === "cancel") return false;
			if (r.button === "save") {
				const ok = await get().save(path);
				if (!ok) return false;
			}
		}
		set((s) => {
			const tabs = s.tabs.filter((t) => t.path !== path);
			let activePath = s.activePath;
			if (activePath === path) {
				const idx = s.tabs.findIndex((t) => t.path === path);
				activePath = tabs[Math.min(idx, tabs.length - 1)]?.path ?? null;
			}
			return { tabs, activePath };
		});
		return true;
	},

	updateContent: (path, content) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path && t.status !== "saving" && t.content !== content
					? { ...t, content, status: "dirty" as DocStatus }
					: t,
			),
		})),

	save: async (path) => {
		const doc = get().tabs.find((t) => t.path === path);
		if (!doc || doc.status === "saving") return false;
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path ? { ...t, status: "saving" as DocStatus } : t,
			),
		}));
		try {
			const newSize = await invoke<number>("write_text_file", {
				path,
				content: doc.content,
				encoding: doc.encoding,
				hasBom: doc.hasBom,
				eol: doc.eol,
			});
			set((s) => ({
				tabs: s.tabs.map((t) =>
					t.path === path
						? { ...t, status: "ready" as DocStatus, lastError: undefined, size: newSize }
						: t,
				),
			}));
			return true;
		} catch (e) {
			set((s) => ({
				tabs: s.tabs.map((t) =>
					t.path === path
						? {
								...t,
								status:
									t.status === "deleted" ? "deleted" : ("dirty" as DocStatus),
								lastError: String(e),
							}
						: t,
				),
			}));
			const { showDialog } = await import("./dialog");
			await showDialog({
				title: "保存失败",
				message: String(e),
				buttons: [{ id: "ok", label: "确定", danger: false }],
			});
			return false;
		}
	},

	saveAll: async () => {
		const dirty = get().tabs.filter(
			(t) => t.status === "dirty" || t.status === "external-changed",
		);
		for (const d of dirty) {
			await get().save(d.path);
		}
	},

	reload: async (path) => {
		try {
			const p = await invoke<FilePayload>("read_text_file", { path });
			set((s) => ({
				tabs: s.tabs.map((t) => (t.path === path ? payloadToDoc(t, p) : t)),
			}));
		} catch {
			// 读取失败（可能刚被删）→ 删除事件随后会标记
		}
	},

	keepLocal: (path) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path && t.status === "external-changed"
					? { ...t, status: "dirty" as DocStatus }
					: t,
			),
		})),

	markExternalChanged: (path) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path && t.status === "dirty"
					? { ...t, status: "external-changed" as DocStatus }
					: t,
			),
		})),

	markDeleted: (path) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path && t.status !== "deleted"
					? { ...t, status: "deleted" as DocStatus }
					: t,
			),
		})),

	renameTab: (fromPath, toPath) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === fromPath
					? { ...t, path: toPath, name: basename(toPath) }
					: t,
			),
			activePath: s.activePath === fromPath ? toPath : s.activePath,
		})),
}));

/** 主动保存当前激活文档（供全局 Ctrl+S） */
export async function saveActive(): Promise<boolean> {
	const { activePath, save } = useTabsStore.getState();
	if (!activePath) return true;
	return save(activePath);
}
