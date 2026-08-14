//! 目录树状态：按目录懒加载 entries
//! M3 接入 notify 后改为增量 patch；当前 refreshDir 为整层重载

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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
		const entries = await invoke<DirEntry[]>("read_dir_entries", { path });
		const root: TreeNode = {
			name: path.split(/[\\/]/).pop() || path,
			path,
			isDir: true,
			size: 0,
			children: entries.map(toNode),
			loaded: true,
		};
		set({ rootPath: path, rootName: root.name, root, expanded: new Set() });
	},

	closeRoot: () =>
		set({ rootPath: null, rootName: "", root: null, expanded: new Set() }),

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
			const entries = await invoke<DirEntry[]>("read_dir_entries", { path });
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
			const entries = await invoke<DirEntry[]>("read_dir_entries", { path });
			set((s) => ({
				root: patchNode(s.root, path, {
					children: entries.map(toNode),
					loaded: true,
					loading: false,
				}),
			}));
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
