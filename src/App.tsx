import { lazy, Suspense, useEffect } from "react";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import TabBar from "./components/TabBar";
import DialogModal from "./components/DialogModal";
import { useThemeStore } from "./stores/theme";
import { saveActive, useTabsStore } from "./stores/tabs";

// 编辑器内核懒加载：首屏不打包 CM6，点开文件才加载（design 7.1）
const EditorHost = lazy(() => import("./editors"));

export default function App() {
	const mode = useThemeStore((s) => s.mode);
	useEffect(() => {
		document.documentElement.dataset.theme = mode;
	}, [mode]);

	const tabs = useTabsStore((s) => s.tabs);
	const activePath = useTabsStore((s) => s.activePath);
	const updateContent = useTabsStore((s) => s.updateContent);
	const activeDoc = tabs.find((t) => t.path === activePath) ?? null;

	// 全局快捷键：Ctrl+S 保存 / Ctrl+W 关闭当前标签（编辑器聚焦时也生效）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && !e.shiftKey && !e.altKey) {
				const k = e.key.toLowerCase();
				if (k === "s") {
					e.preventDefault();
					void saveActive();
				} else if (k === "w") {
					e.preventDefault();
					const s = useTabsStore.getState();
					if (s.activePath) void s.close(s.activePath);
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<div className="app">
			<TopBar />
			<div className="app-main">
				<aside className="panel-left">
					<FileTree />
				</aside>
				<section className="panel-center">
					<TabBar />
					<div className="editor-area">
						{activeDoc ? (
							activeDoc.status === "error" ? (
								<div className="editor-placeholder">
									<div className="logo">⚠️</div>
									<div className="title">打开失败</div>
									<div className="hint">{activeDoc.lastError}</div>
								</div>
							) : (
								<Suspense
									fallback={
										<div className="editor-loading">⏳ 正在加载编辑器…</div>
									}
								>
									<EditorHost
										key={activeDoc.path}
										path={activeDoc.path}
										content={activeDoc.content}
										theme={mode}
										status={activeDoc.status}
										lastError={activeDoc.lastError}
										onChange={(c) => updateContent(activeDoc.path, c)}
									/>
								</Suspense>
							)
						) : (
							<div className="editor-placeholder">
								<div className="logo">📝</div>
								<div className="title">简阅</div>
								<div className="hint">
									轻量 · 快速 · 目录实时同步 · Markdown 所见即所得 · 小说阅读
									<br />
									<kbd>Ctrl+O</kbd> 打开目录 &nbsp; <kbd>Ctrl+S</kbd> 保存
									&nbsp; <kbd>Ctrl+W</kbd> 关闭标签
								</div>
							</div>
						)}
					</div>
				</section>
			</div>
			<StatusBar />
			<DialogModal />
		</div>
	);
}
