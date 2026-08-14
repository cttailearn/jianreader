//! MD 编辑器与大纲侧栏的桥接状态
//! MarkdownEditor 挂载时注入 api（跳转/滚动容器）与大纲数据，
//! TocPanel 消费数据并调用跳转。

import { create } from "zustand";

export interface TocItem {
	level: number; // 1-6
	text: string;
	pos: number; // prosemirror doc 位置
	children: TocItem[];
}

export interface MdEditorApi {
	/** 跳转到指定 doc 位置（滚动 + 光标） */
	jump: (pos: number) => void;
	/** 取编辑器滚动容器（scrollspy 用） */
	getScrollElement: () => HTMLElement | null;
	/** 大纲数据源（编辑时刷新） */
	refreshToc: () => void;
	/** 调试/验收：取 PM 视图 */
	getView?: () => unknown;
}

interface MdState {
	toc: TocItem[];
	activePos: number | null;
	api: MdEditorApi | null;
	setToc: (toc: TocItem[]) => void;
	setActive: (pos: number | null) => void;
	setApi: (api: MdEditorApi | null) => void;
}

export const useMdStore = create<MdState>((set) => ({
	toc: [],
	activePos: null,
	api: null,
	setToc: (toc) => set({ toc }),
	setActive: (activePos) => set({ activePos }),
	setApi: (api) => set({ api }),
}));

/** 从 prosemirror doc 提取标题大纲树（按层级嵌套） */
export function buildToc(doc: {
	descendants: (
		fn: (
			node: {
				type: { name: string };
				attrs: { level?: number };
				textContent: string;
			},
			pos: number,
		) => void,
	) => void;
}): TocItem[] {
	const stack: TocItem[] = [];
	const root: TocItem[] = [];
	const lastAtLevel: (TocItem | null)[] = new Array(7).fill(null);

	doc.descendants((node, pos) => {
		if (node.type.name !== "heading") return;
		const level = Math.min(Math.max(node.attrs.level ?? 1, 1), 6);
		const item: TocItem = {
			level,
			text: node.textContent || "（无标题）",
			pos,
			children: [],
		};
		// 找到最近的父级（层级小于当前）
		while (stack.length > 0 && stack[stack.length - 1].level >= level) {
			stack.pop();
		}
		const parent = stack.length > 0 ? stack[stack.length - 1] : null;
		if (parent) {
			parent.children.push(item);
		} else {
			root.push(item);
		}
		stack.push(item);
		lastAtLevel[level] = item;
		// 清理更深层记录
		for (let i = level + 1; i <= 6; i++) lastAtLevel[i] = null;
	});
	void lastAtLevel;
	return root;
}
