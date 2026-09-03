//! 标签页/文档状态机（design.md 3.6）
//! closed → loading → ready → dirty → (saving) → ready
//! ready + 外部修改 → 自动重载（rev+1 重建编辑器）
//! dirty + 外部修改 → external-changed（提示条；externalModified 持久标记分叉，R-13）
//! 磁盘删除 → deleted（保存可重建）

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getLanguage, isImagePath } from "../utils/language";
import { useSettingsStore } from "./settings";
import type { ScanResult } from "./novel";

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
	/** 只读（磁盘只读属性），禁止编辑/保存 */
	readonly: boolean;
	/** 只读原因：disk 磁盘属性 */
	readonlyReason?: "disk";
	/** 大文件标记（>8MB）：提示内存占用（R-17） */
	large?: boolean;
	/** 已被逐出内存（内容为空，切回时重读，R-19） */
	evicted?: boolean;
	/** 磁盘分叉标记（外部修改后本地未加载或已分叉）：输入不清除，保存时需确认（R-13） */
	externalModified?: boolean;
	lastError?: string;
}

/** R-19：超过该大小（4MB）的非激活大文件标签会被逐出内容（仅留元数据，切回重读） */
const EVICT_MIN = 4 * 1024 * 1024;

interface FilePayload {
	content: string;
	encoding: string;
	has_bom: boolean;
	eol: string;
	size: number;
	readonly: boolean;
	large: boolean;
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
		large: p.large,
		evicted: false,
		lastError: undefined,
	};
}

/** R-19：对非激活的大文件（≥EVICT_MIN、ready、未编辑）标签逐出 content，仅保留元数据 */
export function applyEviction(tabs: TabDoc[], activePath: string | null): TabDoc[] {
	return tabs.map((t) => {
		if (
			t.path !== activePath &&
			!t.isNovel &&
			t.evicted !== true &&
			t.size >= EVICT_MIN &&
			t.status === "ready"
		) {
			return { ...t, content: "", evicted: true };
		}
		return t;
	});
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function parentOf(path: string): string | null {
	const m = path.replace(/[\\/][^\\/]*$/, "");
	return m && m !== path ? m : null;
}

/** 登记路径作用域（R-07）：打开文件前放行其父目录读/写 */
async function registerFileScope(path: string): Promise<void> {
	const p = parentOf(path);
	if (!p) return;
	try {
		await invoke("fs_scope_allow", { path: p, recursive: false });
	} catch {
		/* 忽略：状态未就绪时放行 */
	}
}

interface TabsState {
	tabs: TabDoc[];
	activePath: string | null;
	openFile: (path: string) => Promise<void>;
	activate: (path: string) => Promise<void>;
	close: (path: string) => Promise<boolean>;
	/** 编辑器内容变更（自动标记 dirty；externalModified 保留分叉标记） */
	updateContent: (path: string, content: string) => void;
	/** 静默同步内容（不标 dirty）：编辑器解析规范化后同步 */
	syncContent: (path: string, content: string) => void;
	save: (path: string) => Promise<boolean>;
	saveAll: () => Promise<void>;
	reload: (path: string) => Promise<void>;
	keepLocal: (path: string) => void;
	markExternalChanged: (path: string) => void;
	markDeleted: (path: string) => void;
	renameTab: (fromPath: string, toPath: string) => void;
	toggleMdView: (path: string) => void;
	setNovelDirty: (path: string, dirty: boolean) => void;
	enterNovelMode: (path: string) => Promise<boolean>;
	openInReader: (path: string) => Promise<void>;
	exitNovelMode: (path: string) => Promise<boolean>;
}

export const useTabsStore = create<TabsState>((set, get) => ({
	tabs: [],
	activePath: null,

	openFile: async (path) => {
		const existing = get().tabs.find((t) => t.path === path);
		if (existing) {
			// R-19：若该标签已被逐出，激活流程会先重读再切到它
			await get().activate(path);
			return;
		}
		// R-07：先登记路径作用域（读/写/删都在其父目录内被允许）
		await registerFileScope(path);
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
		// R-19：新增标签时同步逐出其它非激活大文件
		set((s) => ({
			tabs: applyEviction([...s.tabs, doc], path),
			activePath: path,
		}));
		// 图片文件：不做文本解码，直接以图片标签打开
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
		// txt → 扫描一次并复用（R-21）：命中章节自动进入小说；否则普通读并复用编码/EOF
		if (/\.txt$/i.test(path)) {
			const { useNovelStore, getReadingSettings } = await import("./novel");
			const rs = getReadingSettings(path);
			const scan = await invoke<ScanResult>("scan_chapters", {
				path,
				encodingOverride: rs.encoding || null,
				customPattern: rs.chapterRegex || null,
			}).catch(() => null);
			if (scan) {
				const isNovel = await useNovelStore
					.getState()
					.loadBook(path, false, scan);
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
										large: scan.total_bytes > 8 * 1024 * 1024,
									}
								: t,
						),
					}));
					return;
				}
			}
			try {
				const p = await invoke<FilePayload>("read_text_file", {
					path,
					encodingOverride: scan?.encoding ?? null,
					hasBomOverride: scan?.has_bom ?? null,
				});
				set((s) => ({
					tabs: s.tabs.map((t) => (t.path === path ? payloadToDoc(t, p) : t)),
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

	activate: async (path) => {
		// R-19：先切到目标标签（并逐出其它非激活大文件）；若目标曾被逐出，再异步重读
		const wasEvicted = get().tabs.find((t) => t.path === path)?.evicted ?? false;
		set((s) => ({
			...s,
			activePath: path,
			tabs: applyEviction(s.tabs, path).map((t) =>
				t.path === path && wasEvicted
					? { ...t, status: "loading" as DocStatus }
					: t,
			),
		}));
		if (!wasEvicted) return;
		try {
			const p = await invoke<FilePayload>("read_text_file", { path });
			set((s) => ({
				tabs: s.tabs.map((t) => (t.path === path ? payloadToDoc(t, p) : t)),
			}));
		} catch (e) {
			set((s) => ({
				tabs: s.tabs.map((t) =>
					t.path === path
						? { ...t, evicted: false, status: "error", lastError: String(e) }
						: t,
				),
			}));
		}
	},

	close: async (path) => {
		const doc = get().tabs.find((t) => t.path === path);
		if (!doc) return true;
		cancelAutosave(path);
		// 小说脏状态：status 可能未即时同步，双保险
		const novelDirty =
			doc.isNovel && (await import("./novel")).useNovelStore.getState().hasDirty(path);
		if (doc.status === "dirty" || doc.status === "external-changed" || novelDirty) {
			const { showDialog } = await import("./dialog");
			const r = await showDialog({
				title: "未保存的更改",
				message: `「${doc.name}」已修改，是否保存？（小说将保存全部已修改章节）`,
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
		// R-19：关闭后新激活的标签若曾被逐出 → 经 activate 重读（并逐出其它非激活大文件）
		const na = get().activePath;
		if (na && na !== path && get().tabs.find((t) => t.path === na)?.evicted) {
			void get().activate(na);
		}
		return true;
	},

	updateContent: (path, content) =>
		set((s) => ({
			tabs: s.tabs.map((t) => {
				if (t.path !== path || t.status === "saving" || t.content === content)
					return t;
				// R-13：externalModified 不被输入清除（分叉事实保留，保存时确认）
				const next = { ...t, content, status: "dirty" as DocStatus };
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
		if (doc.readonly) {
			const { showDialog } = await import("./dialog");
			await showDialog({
				title: "无法保存",
				message: `「${doc.name}」为只读文件（磁盘只读属性），无法保存。`,
				buttons: [{ id: "ok", label: "确定", danger: false }],
			});
			return false;
		}
		// 小说标签：保存全部 dirty 章（R-01）
		if (doc.isNovel) {
			const { useNovelStore } = await import("./novel");
			try {
				const ok = await useNovelStore.getState().saveChapter(path);
				get().setNovelDirty(path, !ok);
				if (!ok) {
					const { showDialog } = await import("./dialog");
					await showDialog({
						title: "保存冲突",
						message: "保存过程中文档仍有修改，已保留这些修改，请再次保存。",
						buttons: [{ id: "ok", label: "确定", danger: false }],
					});
				}
				return ok;
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
		// R-13：磁盘分叉确认
		if (doc.externalModified) {
			const { showDialog } = await import("./dialog");
			const r = await showDialog({
				title: "覆盖外部修改",
				message: `「${doc.name}」在磁盘上已被外部修改，当前保存会用本地版本覆盖它。确认继续？`,
				buttons: [
					{ id: "overwrite", label: "覆盖", danger: true },
					{ id: "cancel", label: "取消", danger: false },
				],
			});
			if (r.button !== "overwrite") return false;
		}
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path ? { ...t, status: "saving" as DocStatus } : t,
			),
		}));
		// R-03：记录保存起点，写盘后对比，防止保存期间输入被静默丢弃
		const contentAtStart = doc.content;
		try {
			const newSize = await invoke<number>("write_text_file", {
				path,
				content: contentAtStart,
				encoding: doc.encoding,
				hasBom: doc.hasBom,
				eol: doc.eol,
			});
			const current = get().tabs.find((t) => t.path === path);
			const changedDuringSave = !!current && current.content !== contentAtStart;
			if (changedDuringSave) {
				// 写盘期间用户继续输入：保留为新 dirty，并提示
				set((s) => ({
					tabs: s.tabs.map((t) =>
						t.path === path
							? {
									...t,
									status: "dirty" as DocStatus,
									size: newSize,
									externalModified: false,
								}
							: t,
					),
				}));
				const { showDialog } = await import("./dialog");
				await showDialog({
					title: "保存冲突",
					message: `「${doc.name}」保存时又有输入，未写入磁盘的部分已保留，请再次保存。`,
					buttons: [{ id: "ok", label: "确定", danger: false }],
				});
				return false;
			}
			set((s) => ({
				tabs: s.tabs.map((t) =>
					t.path === path
						? {
								...t,
								status: "ready" as DocStatus,
								lastError: undefined,
								size: newSize,
								externalModified: false,
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
		if (doc?.isNovel) {
			const { useNovelStore } = await import("./novel");
			await useNovelStore.getState().reloadBook(path);
			get().setNovelDirty(path, false);
			return;
		}
		try {
			const p = await invoke<FilePayload>("read_text_file", { path });
			set((s) => ({
				tabs: s.tabs.map((t) => {
					if (t.path !== path) return t;
					const next = payloadToDoc(t, p);
					// 外部重载后清除分叉标记
					next.externalModified = false;
					return next;
				}),
			}));
			// R-19：重载后对非激活大文件重新逐出（避免外部修改重载让内存短暂飙升后长期驻留）
			set((s) => ({ tabs: applyEviction(s.tabs, s.activePath) }));
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
				t.path === path && (t.status === "ready" || t.status === "dirty")
					? { ...t, status: "external-changed" as DocStatus, externalModified: true }
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
		// 有未保存修改时先确认
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
		const { useNovelStore } = await import("./novel");
		const st = useNovelStore.getState();
		// R-01：退出前处理未保存修改
		if (st.hasDirty(path)) {
			const { showDialog } = await import("./dialog");
			const r = await showDialog({
				title: "未保存的更改",
				message: "退出阅读模式前需处理未保存的章节修改。",
				buttons: [
					{ id: "save", label: "保存并退出", danger: false },
					{ id: "discard", label: "放弃修改", danger: true },
					{ id: "cancel", label: "取消", danger: false },
				],
			});
			if (r.button === "cancel") return false;
			if (r.button === "save") {
				try {
					const ok = await st.saveChapter(path);
					if (!ok) return false;
				} catch {
					return false;
				}
			}
		}
		set((s) => ({
			tabs: s.tabs.map((t) =>
				t.path === path
					? { ...t, isNovel: false, status: "loading" as DocStatus, rev: t.rev + 1 }
					: t,
			),
		}));
		st.unloadBook(path);
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
		return true;
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
