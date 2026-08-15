//! MD 大纲侧栏：层级树 + 点击跳转 + 滚动跟随高亮 + 子级折叠
//! 数据来自 md store（MarkdownEditor 编辑时实时刷新）

import { useState } from "react";
import { useMdStore, type TocItem } from "../stores/md";

function TocItemRow({
	item,
	depth,
	activeSet,
	collapsed,
	onToggle,
	onJump,
}: {
	item: TocItem;
	depth: number;
	activeSet: Set<string>;
	collapsed: Set<string>;
	onToggle: (pos: number) => void;
	onJump: (pos: number) => void;
}) {
	const hasChildren = item.children.length > 0;
	const key = String(item.pos);
	const isCollapsed = collapsed.has(key);
	const isActive = activeSet.has(key);

	return (
		<>
			<div
				className={
					"toc-row" + (isActive ? " active" : "") + (depth === 0 ? " top" : "")
				}
				style={{ paddingLeft: 8 + depth * 14 }}
				onClick={() => onJump(item.pos)}
				title={item.text}
			>
				{hasChildren ? (
					<span
						className="toc-caret"
						onClick={(e) => {
							e.stopPropagation();
							onToggle(item.pos);
						}}
					>
						{isCollapsed ? "▸" : "▾"}
					</span>
				) : (
					<span className="toc-caret placeholder" />
				)}
				<span className="toc-name">{item.text}</span>
			</div>
			{hasChildren &&
				!isCollapsed &&
				item.children.map((c) => (
					<TocItemRow
						key={c.pos}
						item={c}
						depth={depth + 1}
						activeSet={activeSet}
						collapsed={collapsed}
						onToggle={onToggle}
						onJump={onJump}
					/>
				))}
		</>
	);
}

/** 当前活动章节的祖先链：最近标题 + 其全部父级（滚动跟随高亮） */
function computeActiveSet(
	toc: TocItem[],
	activePos: number | null,
): Set<string> {
	const set = new Set<string>();
	if (activePos === null) return set;
	let deepestPos: number | null = null;
	let deepestPath: string[] = [];
	const walk = (items: TocItem[], path: string[]): void => {
		for (const it of items) {
			if (it.pos <= activePos) {
				if (deepestPos === null || it.pos > deepestPos) {
					deepestPos = it.pos;
					deepestPath = path;
				}
				walk(it.children, [...path, String(it.pos)]);
			}
		}
	};
	walk(toc, []);
	if (deepestPos !== null) {
		set.add(String(deepestPos));
		deepestPath.forEach((p) => set.add(p));
	}
	return set;
}

export default function TocPanel() {
	const toc = useMdStore((s) => s.toc);
	const activePos = useMdStore((s) => s.activePos);
	const api = useMdStore((s) => s.api);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const activeSet = computeActiveSet(toc, activePos);

	if (!api) return null;

	return (
		<div className="toc-panel">
			<div className="toc-header">大纲</div>
			<div className="toc-body">
				{toc.length === 0 ? (
					<div className="toc-empty">无标题</div>
				) : (
					toc.map((item) => (
						<TocItemRow
							key={item.pos}
							item={item}
							depth={0}
							activeSet={activeSet}
							collapsed={collapsed}
							onToggle={(pos) =>
								setCollapsed((prev) => {
									const next = new Set(prev);
									const k = String(pos);
									if (next.has(k)) next.delete(k);
									else next.add(k);
									return next;
								})
							}
							onJump={(pos) => api.jump(pos)}
						/>
					))
				)}
			</div>
			<div className="toc-footer">共 {countAll(toc)} 个标题</div>
		</div>
	);
}

function countAll(items: TocItem[]): number {
	return items.reduce((n, i) => n + 1 + countAll(i.children), 0);
}
