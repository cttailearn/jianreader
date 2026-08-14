import { useThemeStore } from "../stores/theme";

/** 状态栏：M1 仅显示主题名占位，后续加编码/语言/行列/修改标记/大小 */
export default function StatusBar() {
	const mode = useThemeStore((s) => s.mode);
	const toggle = useThemeStore((s) => s.toggle);

	return (
		<footer className="statusbar">
			<span
				className="statusbar-item clickable"
				onClick={toggle}
				title="点击切换主题"
			>
				{mode === "light" ? "☀️ 浅色" : "🌙 暗色"}
			</span>
			<span className="statusbar-item">UTF-8</span>
			<span className="statusbar-item">行 1, 列 1</span>
			<span className="statusbar-spacer" />
			<span className="statusbar-item">v0.1.0 · M1 骨架</span>
		</footer>
	);
}
