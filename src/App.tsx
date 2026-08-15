import { lazy, Suspense, useEffect } from "react";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import TabBar from "./components/TabBar";
import DialogModal from "./components/DialogModal";
import ExternalChangeBar from "./components/ExternalChangeBar";
import TocPanel from "./components/TocPanel";
import ChapterPanel from "./components/ChapterPanel";
import NovelReader from "./components/NovelReader";
import { useThemeStore } from "./stores/theme";
import { saveActive, useTabsStore } from "./stores/tabs";
import { initWatcher } from "./stores/watcher";
import {
	loadSession,
	restoreWindowBounds,
	saveSession,
	saveWindowBounds,
} from "./stores/session";
import { isMarkdownPath } from "./utils/mdImage";
import { useTreeStore } from "./stores/tree";

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
	const syncContent = useTabsStore((s) => s.syncContent);
	const activeDoc = tabs.find((t) => t.path === activePath) ?? null;
	const rootPath = useTreeStore((s) => s.rootPath);

	// 会话恢复（M6）：窗口位置 + 上次目录/标签/激活标签
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			await restoreWindowBounds();
			const session = loadSession();
			if (!session?.root) return;
			const tree = useTreeStore.getState();
			const ts = useTabsStore.getState();
			try {
				await tree.openRoot(session.root);
			} catch {
				return; // 目录已不可用（U 盘拔出/删除）→ 不恢复标签
			}
			for (const p of session.tabs ?? []) {
				if (cancelled) return;
				await ts.openFile(p).catch(() => {
					/* 文件已不存在则跳过 */
				});
			}
			if (
				session.active &&
				useTabsStore.getState().tabs.some((t) => t.path === session.active)
			) {
				useTabsStore.getState().activate(session.active);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// 会话持久化（防抖）：目录/标签/激活标签变化后落盘
	useEffect(() => {
		const t = setTimeout(() => {
			saveSession({
				root: rootPath,
				tabs: tabs.map((t) => t.path),
				active: activePath,
			});
		}, 400);
		return () => clearTimeout(t);
	}, [tabs, activePath, rootPath]);

	// 窗口位置周期保存（5s；关闭前最后状态兜底在 Rust 侧无钩子，周期足够）
	useEffect(() => {
		const id = setInterval(() => {
			void saveWindowBounds();
		}, 5000);
		return () => clearInterval(id);
	}, []);

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

	// fs-event 全局监听（Rust notify → 目录树/标签同步）
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		initWatcher()
			.then((u) => {
				unlisten = u;
			})
			.catch((e) => console.warn("watcher listen failed:", e));
		return () => unlisten?.();
	}, []);

	return (
		<div className="app">
			<TopBar />
			<div className="app-main">
				<aside className="panel-left">
					{activeDoc?.isNovel ? (
						<ChapterPanel path={activeDoc.path} />
					) : (
						<FileTree />
					)}
				</aside>
				<section className="panel-center">
					<TabBar />
					<div className="editor-area">
						{activeDoc && activeDoc.status === "external-changed" && (
							<ExternalChangeBar path={activeDoc.path} />
						)}
						{activeDoc ? (
							activeDoc.status === "error" ? (
								<div className="editor-placeholder">
									<div className="logo">⚠️</div>
									<div className="title">打开失败</div>
									<div className="hint">{activeDoc.lastError}</div>
								</div>
							) : activeDoc.status === "deleted" ? (
								<div className="editor-placeholder">
									<div className="logo">🗑️</div>
									<div className="title">文件已被删除</div>
									<div className="hint">
										该文件在磁盘上已不存在。
										<br />
										{!activeDoc.isNovel && (
											<>
												<kbd>Ctrl+S</kbd> 可在原位置重建文件
											</>
										)}
									</div>
								</div>
							) : activeDoc.isNovel ? (
								<NovelReader key={activeDoc.path} path={activeDoc.path} />
							) : (
								<Suspense
									fallback={<div className="editor-loading">⏳ 正在加载编辑器…</div>}
								>
									<EditorHost
										key={`${activeDoc.path}:${activeDoc.rev}:${activeDoc.mdView}`}
										path={activeDoc.path}
										content={activeDoc.content}
										theme={mode}
										status={activeDoc.status}
										mdView={activeDoc.mdView}
										lastError={activeDoc.lastError}
										readonly={activeDoc.readonly}
										onChange={(c) => updateContent(activeDoc.path, c)}
										onSync={(c) => syncContent(activeDoc.path, c)}
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
									<kbd>Ctrl+O</kbd> 打开目录 &nbsp; <kbd>Ctrl+S</kbd> 保存 &nbsp;{" "}
									<kbd>Ctrl+W</kbd> 关闭标签
								</div>
							</div>
						)}
						{activeDoc?.readonly && activeDoc.readonlyReason === "large" && (
							<div className="large-file-bar">
								⚠️ 文件超过 5MB，已转为只读保护模式（避免卡顿），仅可查看。
							</div>
						)}
					</div>
				</section>
				{activeDoc && !activeDoc.isNovel && isMarkdownPath(activeDoc.path) && (
					<aside className="panel-right">
						<TocPanel />
					</aside>
				)}
			</div>
			<StatusBar />
			<DialogModal />
		</div>
	);
}
