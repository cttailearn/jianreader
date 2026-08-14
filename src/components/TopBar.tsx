import { useEffect } from "react";
import { useThemeStore } from "../stores/theme";

/** 顶栏：应用标题 + 主题切换（后续 M2+ 加新建/刷新/大纲开关等） */
export default function TopBar() {
	const mode = useThemeStore((s) => s.mode);
	const toggle = useThemeStore((s) => s.toggle);

	// 快捷键 Ctrl+Shift+T 切换主题
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
				e.preventDefault();
				toggle();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggle]);

	return (
		<header className="topbar">
			<span className="topbar-title">简阅</span>
			<button
				className="icon-btn"
				onClick={toggle}
				title={`切换主题（当前${mode === "light" ? "浅色" : "暗色"}）Ctrl+Shift+T`}
			>
				{mode === "light" ? "🌙" : "☀️"}
			</button>
		</header>
	);
}
