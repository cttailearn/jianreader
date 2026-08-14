import { useEffect } from "react";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import { useThemeStore } from "./stores/theme";

export default function App() {
	const mode = useThemeStore((s) => s.mode);

	// 主题 token 应用到根节点，CSS 变量全局联动
	useEffect(() => {
		document.documentElement.dataset.theme = mode;
	}, [mode]);

	return (
		<div className="app">
			<TopBar />
			<div className="app-main">
				{/* 左：目录树（M2 实装，当前占位） */}
				<aside className="panel-left">
					<div className="panel-left-header">资源管理器</div>
					<div className="panel-left-body">
						M2 实装：目录树（虚拟滚动、实时同步）
						<br />
						<br />
						Ctrl+O 打开目录
					</div>
				</aside>

				{/* 中：标签页 + 编辑器（M2 实装，当前占位） */}
				<section className="panel-center">
					<div className="tabbar-placeholder" />
					<div className="editor-placeholder">
						<div className="logo">📝</div>
						<div className="title">简阅</div>
						<div className="hint">
							轻量 · 快速 · 目录实时同步 · Markdown 所见即所得 · 小说阅读
							<br />
							<kbd>Ctrl+O</kbd> 打开目录 &nbsp; <kbd>Ctrl+Shift+T</kbd> 切换主题
						</div>
					</div>
				</section>
			</div>
			<StatusBar />
		</div>
	);
}
