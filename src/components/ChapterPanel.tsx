//! 小说章节目录侧栏：章节列表（虚拟滚动）+ 点击跳章 + 当前章高亮 + dirty 圆点
//! 小说模式下替代左侧文件树（design 3.8）

import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNovelStore } from "../stores/novel";

export default function ChapterPanel({ path }: { path: string }) {
	const book = useNovelStore((s) => s.books.get(path));
	const gotoChapter = useNovelStore((s) => s.gotoChapter);
	const parentRef = useRef<HTMLDivElement>(null);

	const chapters = useMemo(() => book?.scan.chapters ?? [], [book?.scan]);

	const virtualizer = useVirtualizer({
		count: chapters.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 30,
		overscan: 12,
	});

	// 当前章滚动到可视区
	const activeIdx = book?.chapterIdx ?? 0;
	useEffect(() => {
		virtualizer.scrollToIndex(activeIdx, { align: "auto" });
	}, [activeIdx, virtualizer]);

	if (!book) return null;

	return (
		<div className="chapter-panel">
			<div className="chapter-panel-header">
				<span className="chapter-panel-title">章节目录</span>
				<span className="chapter-panel-count">{book.scan.chapters.length} 章</span>
			</div>
			<div className="chapter-list" ref={parentRef}>
				<div
					style={{
						height: virtualizer.getTotalSize(),
						width: "100%",
						position: "relative",
					}}
				>
					{virtualizer.getVirtualItems().map((vi) => {
						const ch = chapters[vi.index];
						if (!ch) return null;
						const active = vi.index === activeIdx;
						const dirty = book.dirtySet.has(vi.index);
						return (
							<div
								key={ch.start}
								className={
									"chapter-row" +
									(active ? " active" : "") +
									(ch.level === 1 ? " volume" : "")
								}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${vi.start}px)`,
									height: vi.size,
									paddingLeft: ch.level === 1 ? 8 : 22,
								}}
								onClick={() => void gotoChapter(path, vi.index)}
								title={ch.title}
							>
								{dirty && <span className="chapter-dirty" title="已修改" />}
								<span className="chapter-name">{ch.title}</span>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
