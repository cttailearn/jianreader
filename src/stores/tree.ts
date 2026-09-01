//! 目录树状态：按目录懒加载 entries
//! M3：notify 事件 → applyFsEvent 增量刷新（仅重载已加载的父目录层）
//! M10：openRoot 成功后记录最近打开的目录（recent store，顶栏下拉）

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { FsEvent } from "./watcher";
import { useSettingsStore } from "./settings";
import { useRecentStore } from "./recent";

export interface TreeNode {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	children?: TreeNode[]; // 仅目录已加载时存在
	loaded?: boolean; // 目录层已加载
	loading?: boolean;
}

interface DirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	size: number;
}

interface TreeState {
	rootPath: string | null;
	rootName: string;
	root: TreeNode | null;
	expanded: Set<string>;
	openRoot: (path: string) => Promise<void>;
	closeRoot: () => void;
	toggleExpand: (path: string) => Promise<void>;
	/** 重载某一层（新建/删除/重命名后调用） */
	refreshDir: (path: string) => Promise<void>;
	refreshRoot: () => Promise<void>;
	/** M3：notify 事件增量更新（父目录已加载才刷新） */
	applyFsEvent: (ev: FsEvent) => void;
}

function toNode(e: DirEntry): TreeNode {
	return {
		name: e.name,
		path: e.path,
		isDir: e.is_dir,
		size: e.size,
	};
}

export const useTreeStore = create<TreeState>((set, get) => ({
	rootPath: null,
	rootName: "",
	root: null,
	expanded: new Set(),

	openRoot: async (path) => {
		const entries = await invoke<DirEntry[]>("read_dir_entries", {
			path,
			showHidden: useSettingsStore.getState().settings.showHidden,
		});
		const root: TreeNode = {
			name: path.split(/[\\/]/).pop() || path,
			path,
			isDir: true,
			size: 0,
			children: entries.map(toNode),
			loaded: true,
		};
		set({ rootPath: path, rootName: root.name, root, expanded: new Set() });
		// 记录最近打开的目录（顶栏下拉可快速选择，M10）
		useRecentStore.getState().record(path);
		// 启动监听（M7 多根：不停止其它窗口的监听；失败不阻断浏览）
		try {
			await invoke("start_watch", { path });
		} catch (e) {
			console.warn("start_watch failed:", e);
		}
	},

	closeRoot: () => {
		// M7：只停本窗口根目录的监听（多窗口各自独立）
		const cur = get().rootPath;
		if (cur) void invoke("stop_watch", { path: cur }).catch(() => {});
		set({ rootPath: null, rootName: "", root: null, expanded: new Set() });
	},

	toggleExpand: async (path) => {
		const node = findNode(get().root, path);
		if (!node) return;
		if (node.loaded) {
			// 折叠/展开只是切换 expanded 集合
			set((s) => {
				const next = new Set(s.expanded);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				return { expanded: next };
			});
			return;
		}
		set((s) => ({
			root: patchNode(s.root, path, { loading: true }),
		}));
		try {
			const entries = await invoke<DirEntry[]>("read_dir_entries", {
				path,
				showHidden: useSettingsStore.getState().settings.showHidden,
			});
			set((s) => {
				const next = new Set(s.expanded);
				next.add(path);
				return {
					expanded: next,
					root: patchNode(s.root, path, {
						children: entries.map(toNode),
						loaded: true,
						loading: false,
					}),
				};
			});
		} catch {
			set((s) => ({ root: patchNode(s.root, path, { loading: false }) }));
		}
	},

	refreshDir: async (path) => {
		const isExpanded = get().expanded.has(path);
		try {
			const entries = await invoke<DirEntry[]>("read_dir_entries", {
				path,
				showHidden: useSettingsStore.getState().settings.showHidden,
			});
			set((s) => {
				// 保留已加载子目录节点：刷新父层时，已展开子目录的 children/loaded
				// 不被新条目覆盖（否则展开的子目录会视觉"收纳"，M 修正）
				const oldNode = findNode(s.root, path);
				const oldByPath = new Map<string, TreeNode>();
				for (const c of oldNode?.children ?? []) oldByPath.set(c.path, c);
				const children = entries.map((e) => {
					const old = oldByPath.get(e.path);
					return old && old.isDir && old.loaded ? old : toNode(e);
				});
				return {
					root: patchNode(s.root, path, {
						children,
						loaded: true,
						loading: false,
					}),
				};
			});
		} catch {
			/* 目录可能已不存在 */
		}
		if (!isExpanded) {
			// 刷新后保持折叠状态
			set((s) => {
				const next = new Set(s.expanded);
				next.delete(path);
				return { expanded: next };
			});
		}
	},

	refreshRoot: async () => {
		const p = get().rootPath;
		if (p) await get().refreshDir(p);
	},

	applyFsEvent: (ev) => {
		const { root, refreshDir } = get();
		if (!root) return;
		const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
		// 仅当该目录层已加载（用户在树里展开过）才刷新
		const refreshIfLoaded = (dir: string) => {
			const node = findNode(root, dir);
			if (node && node.loaded) void refreshDir(dir);
		};
		if (ev.kind === "rename") {
			if (ev.from_path) refreshIfLoaded(dirname(ev.from_path));
			refreshIfLoaded(dirname(ev.path));
		} else if (ev.kind === "create" || ev.kind === "remove") {
			refreshIfLoaded(dirname(ev.path));
		}
		// modify 不需要动目录树（内容变更由标签页处理）
	},
}));

function findNode(root: TreeNode | null, path: string): TreeNode | null {
	if (!root) return null;
	if (root.path === path) return root;
	for (const c of root.children ?? []) {
		const hit = findNode(c, path);
		if (hit) return hit;
	}
	return null;
}

function patchNode(
	root: TreeNode | null,
	path: string,
	patch: Partial<TreeNode>,
): TreeNode | null {
	if (!root) return null;
	if (root.path === path) return { ...root, ...patch };
	if (!root.children) return root;
	let changed = false;
	const children = root.children.map((c) => {
		const hit = patchNode(c, path, patch);
		if (hit !== c) {
			changed = true;
			return hit!;
		}
		return c;
	});
	return changed ? { ...root, children } : root;
}

/** 展开的可见行（虚拟列表数据源）：{ node, depth } 扁平化 */
export interface FlatRow {
	node: TreeNode;
	depth: number;
	expanded: boolean;
}

export function flattenTree(
	root: TreeNode | null,
	expanded: Set<string>,
): FlatRow[] {
	const rows: FlatRow[] = [];
	const walk = (node: TreeNode, depth: number) => {
		const isExpanded = expanded.has(node.path);
		rows.push({ node, depth, expanded: isExpanded });
		if (node.isDir && isExpanded) {
			for (const c of node.children ?? []) walk(c, depth + 1);
		}
	};
	if (root) walk(root, 0);
	return rows;
}
