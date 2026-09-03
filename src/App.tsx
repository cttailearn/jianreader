import { lazy, Suspense, useEffect, useState } from "react";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import TabBar from "./components/TabBar";
import DialogModal from "./components/DialogModal";
import ExternalChangeBar from "./components/ExternalChangeBar";
import UpdateNotice from "./components/UpdateNotice";
import TocPanel from "./components/TocPanel";
import ChapterPanel from "./components/ChapterPanel";
import NovelReader from "./components/NovelReader";
import ImageViewer from "./components/ImageViewer";
import PanelResizer from "./components/PanelResizer";
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
import { openWorkspace } from "./utils/openWorkspace";
import { useTreeStore } from "./stores/tree";
import { usePanelsStore } from "./stores/panels";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { matchKey, useKeymapStore } from "./stores/keymap";
import { FONT_FAMILY_OPTIONS, useSettingsStore } from "./stores/settings";
import { useUpdaterStore } from "./stores/updater";
import SettingsPanel from "./components/SettingsPanel";

// 编辑器内核懒加载：首屏不打包 CM6，点开文件才加载（design 7.1）
const EditorHost = lazy(() => import("./editors"));

export default function App() {
	const mode = useThemeStore((s) => s.mode);
	useEffect(() => {
		document.documentElement.dataset.theme = mode;
	}, [mode]);

	// 文本字号/字体：设置变化后以 CSS 变量驱动正文渲染（代码/Markdown/小说）
	const editorFontSize = useSettingsStore((s) => s.settings.editorFontSize);
	const editorFontFamily = useSettingsStore((s) => s.settings.editorFontFamily);
	useEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--editor-font-size", `${editorFontSize}px`);
		const fam =
			FONT_FAMILY_OPTIONS.find((f) => f.id === editorFontFamily)?.family ??
			null;
		// 系统默认 → 移除变量，各文本区回退到各自的默认字体
		if (fam) root.style.setProperty("--editor-font-family", fam);
		else root.style.removeProperty("--editor-font-family");
	}, [editorFontSize, editorFontFamily]);

	const tabs = useTabsStore((s) => s.tabs);
	const activePath = useTabsStore((s) => s.activePath);
	const updateContent = useTabsStore((s) => s.updateContent);
	const syncContent = useTabsStore((s) => s.syncContent);
	const activeDoc = tabs.find((t) => t.path === activePath) ?? null;
	const rootPath = useTreeStore((s) => s.rootPath);
	const leftW = usePanelsStore((s) => s.leftW);
	const rightW = usePanelsStore((s) => s.rightW);
	const [dragOver, setDragOver] = useState(false);

	// 启动参数 ?root=...（M7 多窗口：新窗口加载指定目录，跳过会话恢复）
	const rootParam = (() => {
		const v = new URLSearchParams(window.location.search).get("root");
		return v ? decodeURIComponent(v) : null;
	})();

	// 拖入目录/文件打开（M7）：整窗监听 Tauri drag-drop 事件
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		getCurrentWebview()
			.onDragDropEvent((e) => {
				const p = e.payload;
				if (p.type === "over") {
					setDragOver(true);
				} else if (p.type === "leave") {
					setDragOver(false);
				} else if (p.type === "drop") {
					setDragOver(false);
					void handleDropPaths(p.paths);
				}
			})
			.then((u) => {
				unlisten = u;
			})
			.catch((err) => console.warn("drag-drop listen failed:", err));
		return () => unlisten?.();
	}, []);

	/** 拖入路径分发：目录 → 新开窗口/打开工作区；文件 → 打开标签 */
	async function handleDropPaths(paths: string[]) {
		const ts = useTabsStore.getState();
		for (const p of paths) {
			const isDir = await invoke<boolean>("path_is_dir", { path: p }).catch(
				() => false,
			);
			if (isDir) {
				// 无工作区→原地打开；已有且不同→新开窗口；相同→忽略
				await openWorkspace(p).catch(() => {});
			} else {
				await ts.openFile(p).catch(() => {});
			}
		}
	}

	// 会话恢复（M6/M7）：窗口位置 + 上次目录/标签/激活标签；?root= 参数的新窗口跳过
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			await restoreWindowBounds();
			// 文件关联启动：系统用"打开方式/默认程序"打开文件/目录时，argv 里有路径，
			// 应优先打开它，而非恢复"上次目录"（修复：双击文件却打开旧目录）
			const launchPath = await invoke<string | null>("get_launch_path").catch(() => null);
			if (launchPath) {
				const tree = useTreeStore.getState();
				const ts = useTabsStore.getState();
				const isDir = await invoke<boolean>("path_is_dir", { path: launchPath }).catch(
					() => false,
				);
				if (isDir) {
					await tree.openRoot(launchPath).catch(() => {});
				} else {
					const parent = launchPath.replace(/[\\/][^\\/]*$/, "");
					if (parent && parent !== launchPath) {
						await tree.openRoot(parent).catch(() => {});
					}
					await ts.openFile(launchPath).catch(() => {});
				}
				return;
			}
			if (rootParam) {
				// 多窗口：直接加载指定目录，不做会话恢复
				try {
					await useTreeStore.getState().openRoot(rootParam);
				} catch {
					/* 目录不可用则保持空工作区 */
				}
				return;
			}
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
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

	// 全局快捷键（可自定义，M9）：保存 / 关闭标签 / 下一个标签（设置面板打开时屏蔽）
	const keymap = useKeymapStore((s) => s.keymap);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (useSettingsStore.getState().panelOpen) return;
			if (matchKey(e, keymap.save)) {
				e.preventDefault();
				void saveActive();
			} else if (matchKey(e, keymap.closeTab)) {
				e.preventDefault();
				const s = useTabsStore.getState();
				if (s.activePath) void s.close(s.activePath);
			} else if (matchKey(e, keymap.nextTab)) {
				e.preventDefault();
				const s = useTabsStore.getState();
				if (s.tabs.length < 2) return;
				const idx = s.tabs.findIndex((t) => t.path === s.activePath);
				s.activate(s.tabs[(idx + 1) % s.tabs.length].path);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [keymap]);

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

	// 启动自动检查更新（仅主窗口执行；多窗口工作区窗口不重复检查/不弹横幅）
	useEffect(() => {
		let cancelled = false;
		const t = setTimeout(() => {
			if (cancelled) return;
			try {
				if (getCurrentWindow().label === "main") {
					void useUpdaterStore.getState().checkNow(true);
				}
			} catch {
				/* 非 Tauri 环境（web 预览）忽略 */
			}
		}, 2500);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, []);

	// R-02：关窗 dirty 拦截 —— Rust 侧 CloseRequested 已被 prevent，前端处理未保存后再 finalize_close
	useEffect(() => {
		let un: (() => void) | undefined;
		let running = false;
		import("@tauri-apps/api/event")
			.then(async ({ listen }) => {
				un = await listen("close-requested", async () => {
					if (running) return;
					running = true;
					const s = useTabsStore.getState();
					const { useNovelStore } = await import("./stores/novel");
					const dirty = s.tabs.filter(
						(t) =>
							t.status === "dirty" ||
							t.status === "external-changed" ||
							(t.isNovel && useNovelStore.getState().hasDirty(t.path)),
					);
					const { showDialog } = await import("./stores/dialog");
					try {
						if (dirty.length === 0) {
							await invoke("finalize_close");
							return;
						}
						const r = await showDialog({
							title: "未保存的更改",
							message: `有 ${dirty.length} 个文档存在未保存的修改。全部保存后退出？`,
							buttons: [
								{ id: "save", label: "保存并退出", danger: false },
								{ id: "discard", label: "不保存退出", danger: true },
								{ id: "cancel", label: "取消", danger: false },
							],
						});
						if (r.button === "cancel") {
							running = false;
							return;
						}
						if (r.button === "save") {
							await s.saveAll();
						}
						// 保存后仍有未保存（冲突/失败）→ 二次确认，避免静默丢失
						const stillDirty = useTabsStore.getState().tabs.some(
							(t) =>
								t.status === "dirty" ||
								t.status === "external-changed" ||
								(t.isNovel &&
									useNovelStore.getState().hasDirty(t.path)),
						);
						if (stillDirty) {
							const r2 = await showDialog({
								title: "仍有未保存修改",
								message: "部分文档保存失败或保存后又修改，仍要退出吗？",
								buttons: [
									{ id: "exit", label: "仍要退出", danger: true },
									{ id: "cancel", label: "再看看", danger: false },
								],
							});
							if (r2.button === "cancel") {
								running = false;
								return;
							}
						}
						await invoke("finalize_close");
					} catch {
						running = false;
					}
				});
			})
			.catch(() => {
				/* 非 Tauri 环境忽略 */
			});
		return () => {
			un?.();
		};
	}, []);

	return (
		<div className="app">
			<TopBar />
			<div className="app-main">
				<aside className="panel-left" style={{ width: leftW }}>
					{activeDoc?.isNovel ? (
						<ChapterPanel path={activeDoc.path} />
					) : (
						<FileTree />
					)}
				</aside>
				<PanelResizer side="left" />
				<section className="panel-center">
					<TabBar />
					<div className="editor-area">
						{activeDoc &&
							(activeDoc.status === "external-changed" ||
								activeDoc.externalModified) && (
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
							) : activeDoc.isImage ? (
								<ImageViewer
									key={activeDoc.path}
									path={activeDoc.path}
									size={activeDoc.size}
									name={activeDoc.name}
								/>
							) : (
								<Suspense
									fallback={<div className="editor-loading">⏳ 正在加载编辑器…</div>}
								>
									{/* R-26：仅 Markdown 所见即所得随主题重建；CodeEditor 用 themeComp 热切换，key 不参与 mode */}
									<EditorHost
										key={
											isMarkdownPath(activeDoc.path) && activeDoc.mdView === "wysiwyg"
												? `${activeDoc.path}:${activeDoc.rev}:${activeDoc.mdView}:${mode}`
												: `${activeDoc.path}:${activeDoc.rev}:${activeDoc.mdView}`
										}
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
					</div>
				</section>
				{activeDoc && !activeDoc.isNovel && isMarkdownPath(activeDoc.path) && (
					<>
						<PanelResizer side="right" />
						<aside className="panel-right" style={{ width: rightW }}>
							<TocPanel />
						</aside>
					</>
				)}
			</div>
			<StatusBar />
			<DialogModal />
			<SettingsPanel />
			<UpdateNotice />
			{dragOver && (
				<div className="drop-overlay">
					<div className="drop-overlay-inner">松开以打开</div>
				</div>
			)}
		</div>
	);
}
