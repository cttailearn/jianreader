//! 标签页/文档状态机（design.md 3.6）
//! closed → loading → ready → dirty → (saving) → ready
//! ready + 外部修改 → 自动重载（rev+1 重建编辑器）
//! dirty + 外部修改 → external-changed（提示条）
//! 磁盘删除 → deleted（保存可重建）

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getLanguage, isImagePath } from "../utils/language";
import { useSettingsStore } from "./settings";

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
	/** MD 视图模式：所见即所得 / 源码 */
	mdView: "wysiwyg" | "source";
	/** 小说模式标签：正文按章懒加载，不走全文 content */
	isNovel: boolean;
	/** 图片标签：以图片查看器渲染（不做文本解码） */
	isImage: boolean;
	/** 只读（磁盘只读属性 或 大文件保护），禁止编辑/保存 */
	readonly: boolean;
	/** 只读原因：disk 磁盘属性 / large 超过 5MB 保护 */
	readonlyReason?: "disk" | "large";
	lastError?: string;
}

interface FilePayload {
	content: string;
	encoding: string;
	has_bom: boolean;
	eol: string;
	size: number;
	readonly: boolean;
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
		readonly: p.readonly,
		readonlyReason: p.readonly ? "disk" : undefined,
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
	/** 静默同步内容（不标 dirty）：编辑器解析规范化（如 GFM 任务列表 - → *）后同步 */
	syncContent: (path: string, content: string) => void;
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
	/** MD 视图模式切换（wysiwyg ↔ source） */
	toggleMdView: (path: string) => void;
	/** 小说标签脏状态同步（novel store 的 dirtySet → 标签状态） */
	setNovelDirty: (path: string, dirty: boolean) => void;
	/** 手动进入小说模式（txt 未自动命中时；force 扫描 ≥1 章即进入） */
	enterNovelMode: (path: string) => Promise<boolean>;
	/** 以阅读模式打开：先正常打开，未自动进入小说模式的 txt 强制进入（无章节按整本单章） */
	openInReader: (path: string) => Promise<void>;
	/** 退出小说模式：整读全文，转普通编辑标签 */
	exitNovelMode: (path: string) => Promise<void>;
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
			mdView: "wysiwyg",
			isNovel: false,
			isImage: false,
			readonly: false,
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
		// 图片文件：不做文本解码，直接以图片标签打开（file_meta 取大小/只读）
		if (isImagePath(path)) {
			try {
				const [size, ro] = await invoke<[number, boolean]>("file_meta", { path });
				set((s) => ({
					tabs: s.tabs.map((t) =>
						t.path === path
							? {
									...t,
									isImage: true,
									status: "ready",
									size,
									readonly: ro,
									readonlyReason: ro ? "disk" : undefined,
								}
							: t,
					),
				}));
			} catch (e) {
				set((s) => ({
					tabs: s.tabs.map((t) =>
						t.path === path
							? { ...t, status: "error", lastError: String(e) }
							: t,
					),
				}));
			}
			return;
		}
		// txt → 尝试小说模式（章节扫描 ≥3 章自动进入，零打断）
		if (/\.txt$/i.test(path)) {
			const { useNovelStore } = await import("./novel");
			const isNovel = await useNovelStore.getState().loadBook(path);
			if (isNovel) {
				const scanReadonly =
					useNovelStore.getState().books.get(path)?.scan.readonly ?? false;
				set((s) => ({
					tabs: s.tabs.map((t) =>
						t.path === path
							? {
									...t,
									isNovel: true,
									status: "ready",
									languageName: "小说",
									readonly: scanReadonly,
									readonlyReason: scanReadonly ? "disk" : undefined,
								}
							: t,
					),
				}));
				return;
			}
		}
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
		cancelAutosave(path);
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
		// 小说标签：关闭前记录续读位置并卸载 book（防 books map 泄漏，M9 审查）
		if (doc.isNovel) {
			const { useNovelStore } = await import("./novel");
			useNovelStore.getState().unloadBook(path);
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
			tabs: s.tabs.map((t) => {
				if (t.path !== path || t.status === "saving" || t.content === content)
					return t;
				const next = { ...t, content, status: "dirty" as DocStatus };
				// 自动保存（设置开启时 dirty 后 2s 自动写盘，M9）
				if (useSettingsStore.getState().settings.autoSave && !next.readonly) {
					scheduleAutosave(get, path);
				}
				return next;
			}),
		})),

	syncContent: (path, content) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path && t.content !== content && t.status === "ready"
					? { ...t, content }
					: t,
			),
		})),

	save: async (path) => {
		const doc = get().tabs.find((t) => t.path === path);
		if (!doc || doc.status === "saving") return false;
		cancelAutosave(path);
		// 只读文件拦截（磁盘只读 / 大文件保护）
		if (doc.readonly) {
			const { showDialog } = await import("./dialog");
			await showDialog({
				title: "无法保存",
				message: `「${doc.name}」为只读文件（${
					doc.readonlyReason === "large" ? "超过 5MB 保护" : "磁盘只读属性"
				}），无法保存。`,
				buttons: [{ id: "ok", label: "确定", danger: false }],
			});
			return false;
		}
		// 小说标签：按章写回（write_chapter + 重解析章节表）
		if (doc.isNovel) {
			const { useNovelStore } = await import("./novel");
			try {
				const ok = await useNovelStore.getState().saveChapter(path);
				if (!ok) return false;
				get().setNovelDirty(path, false);
				return true;
			} catch (e) {
				set((s) => ({
					tabs: s.tabs.map((t) =>
						t.path === path
							? { ...t, status: "dirty" as DocStatus, lastError: String(e) }
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
		}
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
						? {
								...t,
								status: "ready" as DocStatus,
								lastError: undefined,
								size: newSize,
							}
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
								status: t.status === "deleted" ? "deleted" : ("dirty" as DocStatus),
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
		const doc = get().tabs.find((t) => t.path === path);
		// 小说标签：重扫章节表 + 重读当前章（不走全文 content）
		if (doc?.isNovel) {
			const { useNovelStore } = await import("./novel");
			await useNovelStore.getState().reloadBook(path);
			get().setNovelDirty(path, false);
			return;
		}
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

	renameTab: (fromPath, toPath) => {
		const wasNovel = get().tabs.find((t) => t.path === fromPath)?.isNovel;
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === fromPath ? { ...t, path: toPath, name: basename(toPath) } : t,
			),
			activePath: s.activePath === fromPath ? toPath : s.activePath,
		}));
		// 小说标签：book 状态按新路径迁移（章节表/设置/书签键一致）
		if (wasNovel) {
			void import("./novel").then(({ useNovelStore }) =>
				useNovelStore.getState().moveBook(fromPath, toPath),
			);
		}
	},

	toggleMdView: (path) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path
					? {
							...t,
							mdView:
								t.mdView === "wysiwyg" ? ("source" as const) : ("wysiwyg" as const),
						}
					: t,
			),
		})),

	setNovelDirty: (path, dirty) =>
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path
					? {
							...t,
							status: dirty
								? t.status === "dirty" || t.status === "external-changed"
									? t.status
									: ("dirty" as DocStatus)
								: ("ready" as DocStatus),
						}
					: t,
			),
		})),

	enterNovelMode: async (path) => {
		const doc = get().tabs.find((t) => t.path === path);
		if (!doc) return false;
		// 有未保存修改时先确认（阅读模式从磁盘读章，不带入内存内容）
		if (doc.status === "dirty" || doc.status === "external-changed") {
			const { showDialog } = await import("./dialog");
			const r = await showDialog({
				title: "未保存的更改",
				message: "进入阅读模式前需先处理「" + doc.name + "」的未保存修改。",
				buttons: [
					{ id: "save", label: "保存并进入", danger: false },
					{ id: "discard", label: "放弃修改", danger: true },
					{ id: "cancel", label: "取消", danger: false },
				],
			});
			if (r.button === "cancel") return false;
			if (r.button === "save") {
				const ok = await get().save(path);
				if (!ok) return false;
			}
		}
		const { useNovelStore } = await import("./novel");
		const ok = await useNovelStore.getState().loadBook(path, true);
		if (!ok) return false;
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path
					? { ...t, isNovel: true, status: "ready", languageName: "小说" }
					: t,
			),
		}));
		return true;
	},

	openInReader: async (path) => {
		await get().openFile(path);
		const doc = get().tabs.find((t) => t.path === path);
		if (doc && !doc.isNovel && /\.txt$/i.test(path)) {
			await get().enterNovelMode(path);
		}
	},

	exitNovelMode: async (path) => {
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path
					? { ...t, isNovel: false, status: "loading" as DocStatus, rev: t.rev + 1 }
					: t,
			),
		}));
		const { useNovelStore } = await import("./novel");
		useNovelStore.getState().unloadBook(path);
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
}));

/** 主动保存当前激活文档（供全局 Ctrl+S） */
export async function saveActive(): Promise<boolean> {
	const { activePath, save } = useTabsStore.getState();
	if (!activePath) return true;
	return save(activePath);
}

// ---- 自动保存（M9）：dirty 后 2s 防抖写盘 ----

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAutosave(get: () => TabsState, path: string) {
	const prev = autosaveTimers.get(path);
	if (prev) clearTimeout(prev);
	autosaveTimers.set(
		path,
		setTimeout(() => {
			autosaveTimers.delete(path);
			void get().save(path).catch(() => {});
		}, 2000),
	);
}

/** 取消某标签的自动保存计时（保存/关闭标签时调用） */
export function cancelAutosave(path: string): void {
	const t = autosaveTimers.get(path);
	if (t) {
		clearTimeout(t);
		autosaveTimers.delete(path);
	}
}
