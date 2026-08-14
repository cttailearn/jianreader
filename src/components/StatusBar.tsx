//! 状态栏：主题 | 编码 | 语言 | 行:列 | 修改标记 | 文件大小 | 版本

import { useThemeStore } from "../stores/theme";
import { useTabsStore } from "../stores/tabs";
import { useCursorStore } from "../stores/ui";
import { formatSize } from "./FileTree";

export default function StatusBar() {
	const mode = useThemeStore((s) => s.mode);
	const toggle = useThemeStore((s) => s.toggle);
	const doc = useTabsStore((s) => s.tabs.find((t) => t.path === s.activePath));
	const cursor = useCursorStore((s) => ({ line: s.line, col: s.col }));

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
					<span className="statusbar-item">
						行 {cursor.line}, 列 {cursor.col}
					</span>
					{doc.status === "dirty" && (
						<span
							className="statusbar-item statusbar-dirty"
							title="有未保存的修改"
						>
							● 已修改
						</span>
					)}
					{doc.status === "saving" && (
						<span className="statusbar-item">💾 保存中…</span>
					)}
					{doc.status === "loading" && (
						<span className="statusbar-item">⏳ 加载中…</span>
					)}
					<span className="statusbar-item">{formatSize(doc.size)}</span>
				</>
			)}
			<span className="statusbar-spacer" />
			<span className="statusbar-item">简阅 v0.1.0</span>
		</footer>
	);
}
