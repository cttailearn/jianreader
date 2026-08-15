//! 顶栏（macOS 风格，M7）：左侧交通灯（红黄绿）+ 中间拖拽区/标题 + 右侧操作按钮
//! 窗口为无边框模式（decorations:false），整栏中段可拖拽移动窗口，双击最大化

import { useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useThemeStore } from "../stores/theme";
import { useTreeStore } from "../stores/tree";
import { showDialog } from "../stores/dialog";
import { invoke } from "@tauri-apps/api/core";

export default function TopBar() {
	const mode = useThemeStore((s) => s.mode);
	const toggle = useThemeStore((s) => s.toggle);
	const rootPath = useTreeStore((s) => s.rootPath);
	const rootName = useTreeStore((s) => s.rootName);
	const openRoot = useTreeStore((s) => s.openRoot);
	const refreshRoot = useTreeStore((s) => s.refreshRoot);

	// 快捷键 Ctrl+Shift+T 主题 / Ctrl+O 打开目录
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
				e.preventDefault();
				toggle();
			} else if (
				e.ctrlKey &&
				!e.shiftKey &&
				!e.altKey &&
				e.key.toLowerCase() === "o"
			) {
				e.preventDefault();
				void pickFolder();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const pickFolder = async () => {
		const dir = await openDialog({
			directory: true,
			title: "选择要打开的文件夹",
		});
		if (typeof dir === "string") {
			try {
				await openRoot(dir);
			} catch (e) {
				await showDialog({
					title: "打开目录失败",
					message: String(e),
					buttons: [{ id: "ok", label: "确定", danger: false }],
				});
			}
		}
	};

	const newFile = async () => {
		if (!rootPath) return;
		const r = await showDialog({
			title: "新建文件",
			inputLabel: "文件名",
			buttons: [
				{ id: "ok", label: "创建", danger: false },
				{ id: "cancel", label: "取消", danger: false },
			],
		});
		if (r.button !== "ok" || !r.input.trim()) return;
		try {
			await invoke("create_file", {
				path: rootPath + "\\" + r.input.trim(),
				isDir: false,
			});
		} catch (e) {
			await showDialog({
				title: "创建失败",
				message: String(e),
				buttons: [{ id: "ok", label: "确定", danger: false }],
			});
		}
		await refreshRoot();
	};

	const win = () => getCurrentWindow();

	// 窗口拖拽（M7 修复）：整栏 mousedown 即可拖动，按钮区域排除。
	// 不用 data-tauri-drag-region（透明+毛玻璃窗口下偶发失效），改 JS startDragging 更可靠
	const onBarMouseDown = (e: React.MouseEvent) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button")) return;
		void win().startDragging();
	};

	return (
		<header className="topbar" onMouseDown={onBarMouseDown}>
			{/* 交通灯：关闭 / 最小化 / 最大化（macOS 惯例） */}
			<div className="mac-lights">
				<button
					className="mac-light mac-light-close"
					title="关闭"
					onClick={() => void win().close()}
				>
					<span>×</span>
				</button>
				<button
					className="mac-light mac-light-min"
					title="最小化"
					onClick={() => void win().minimize()}
				>
					<span>−</span>
				</button>
				<button
					className="mac-light mac-light-max"
					title="最大化 / 还原"
					onClick={() => void win().toggleMaximize()}
				>
					<span>＋</span>
				</button>
			</div>
			{/* 标题（双击最大化由 startDragging 系统行为处理） */}
			<div
				className="topbar-center"
				data-tauri-drag-region
				onDoubleClick={() => void win().toggleMaximize()}
			>
				<span className="topbar-title" title={rootPath ?? "简阅"}>
					{rootName || "简阅"}
				</span>
			</div>
			{/* 操作按钮 */}
			<div className="topbar-actions">
				{rootPath && (
					<button
						className="icon-btn"
						onClick={() => void newFile()}
						title="新建文件"
					>
						＋
					</button>
				)}
				<button
					className="icon-btn"
					onClick={() => void refreshRoot()}
					title="刷新目录"
					disabled={!rootPath}
				>
					🔄
				</button>
				<button
					className="icon-btn"
					onClick={pickFolder}
					title="打开文件夹 (Ctrl+O)"
				>
					📂
				</button>
				<button
					className="icon-btn"
					onClick={toggle}
					title={`切换主题（当前${mode === "light" ? "浅色" : "暗色"}）Ctrl+Shift+T`}
				>
					{mode === "light" ? "🌙" : "☀️"}
				</button>
			</div>
		</header>
	);
}
