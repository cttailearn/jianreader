//! 状态栏：主题 | 编码 | 语言 | 行:列 | 修改标记 | 文件大小 | 版本

import { useThemeStore } from "../stores/theme";
import { useTabsStore } from "../stores/tabs";
import { useCursorStore } from "../stores/ui";
import { useNovelStore } from "../stores/novel";
import { formatSize } from "./FileTree";
import { isMarkdownPath } from "../utils/mdImage";

export default function StatusBar() {
	const mode = useThemeStore((s) => s.mode);
	const toggle = useThemeStore((s) => s.toggle);
	const doc = useTabsStore((s) => s.tabs.find((t) => t.path === s.activePath));
	const toggleMdView = useTabsStore((s) => s.toggleMdView);
	const exitNovelMode = useTabsStore((s) => s.exitNovelMode);
	const enterNovelMode = useTabsStore((s) => s.enterNovelMode);
	const novelBook = useNovelStore((s) =>
		doc ? s.books.get(doc.path) : undefined,
	);
	// 注意：selector 必须返回稳定引用/原始值（zustand v5 快照比较），不能返回新对象
	const cursorPos = useCursorStore((s) => `${s.line}:${s.col}`);

	const enterNovel = async () => {
		if (!doc) return;
		const ok = await enterNovelMode(doc.path);
		if (!ok) {
			const { showDialog } = await import("../stores/dialog");
			await showDialog({
				title: "无法进入阅读模式",
				message: "未在该文件中识别到章节标题（需至少 1 个章节标题）。",
				buttons: [{ id: "ok", label: "确定", danger: false }],
			});
		}
	};

	return (
		<footer className="statusbar">
			<span
				className="statusbar-item clickable"
				onClick={toggle}
				title="点击切换主题"
			>
				{mode === "light" ? "☀️ 浅色" : "🌙 暗色"}
			</span>
			{doc && (
				<>
					<span className="statusbar-item" title="文件编码">
						{doc.encoding}
					</span>
					<span className="statusbar-item">{doc.languageName}</span>
					{doc.readonly && (
						<span
							className="statusbar-item statusbar-readonly"
							title={
								doc.readonlyReason === "large"
									? "超过 5MB 已转只读保护"
									: "磁盘只读属性"
							}
						>
							🔒 只读
						</span>
					)}
					<span className="statusbar-item">
						行 {cursorPos.split(":")[0]}, 列 {cursorPos.split(":")[1]}
					</span>
					{doc.status === "dirty" && (
						<span className="statusbar-item statusbar-dirty" title="有未保存的修改">
							● 已修改
						</span>
					)}
					{doc.status === "saving" && (
						<span className="statusbar-item">💾 保存中…</span>
					)}
					{doc.status === "loading" && (
						<span className="statusbar-item">⏳ 加载中…</span>
					)}
					{isMarkdownPath(doc.path) && (
						<span
							className="statusbar-item clickable"
							onClick={() => toggleMdView(doc.path)}
							title="切换所见即所得/源码模式"
						>
							{doc.mdView === "wysiwyg" ? "📖 所见即所得" : "⌨️ 源码"}
						</span>
					)}
					{doc.isNovel && novelBook && (
						<>
							<span className="statusbar-item" title="当前章节位置">
								第 {novelBook.chapterIdx + 1}/{novelBook.scan.chapters.length} 章
							</span>
							<span
								className="statusbar-item clickable"
								onClick={() => void exitNovelMode(doc.path)}
								title="退出小说模式，切回普通编辑"
							>
								📖 小说模式（点击退出）
							</span>
						</>
					)}
					{!doc.isNovel && /\.txt$/i.test(doc.path) && (
						<span
							className="statusbar-item clickable"
							onClick={() => void enterNovel()}
							title="以小说阅读模式打开（自动识别章节标题）"
						>
							📖 阅读模式
						</span>
					)}
					<span className="statusbar-item">{formatSize(doc.size)}</span>
				</>
			)}
			<span className="statusbar-spacer" />
			<span className="statusbar-item">简阅 v0.1.0</span>
		</footer>
	);
}
