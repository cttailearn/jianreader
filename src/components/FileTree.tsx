//! 目录树：懒加载 + 虚拟滚动 + 右键菜单
//! 文件操作（新建/重命名/删除/资源管理器）全部走 Rust 命令

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
	flattenTree,
	useTreeStore,
	type FlatRow,
	type TreeNode,
} from "../stores/tree";
import { useTabsStore } from "../stores/tabs";
import { showDialog } from "../stores/dialog";
import { openWorkspace } from "../utils/openWorkspace";
import { fileIcon } from "../utils/language";

interface MenuState {
	x: number;
	y: number;
	node: TreeNode;
}

function parentOf(p: string): string {
	return p.replace(/[\\/][^\\/]*$/, "");
}

function failDialog(title: string, e: unknown) {
	return showDialog({
		title,
		message: String(e),
		buttons: [{ id: "ok", label: "确定", danger: false }],
	});
}

export default function FileTree() {
	const root = useTreeStore((s) => s.root);
	const rootName = useTreeStore((s) => s.rootName);
	const expanded = useTreeStore((s) => s.expanded);
	const toggleExpand = useTreeStore((s) => s.toggleExpand);
	const refreshDir = useTreeStore((s) => s.refreshDir);
	const refreshRoot = useTreeStore((s) => s.refreshRoot);
	const activePath = useTabsStore((s) => s.activePath);
	const openFile = useTabsStore((s) => s.openFile);
	const closeTab = useTabsStore((s) => s.close);

	const rows = useMemo(() => flattenTree(root, expanded), [root, expanded]);
	const parentRef = useRef<HTMLDivElement>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 24,
		overscan: 15,
	});

	// 点击任意处关闭右键菜单
	useEffect(() => {
		const close = () => setMenu(null);
		window.addEventListener("click", close);
		return () => window.removeEventListener("click", close);
	}, []);

	const pickFolder = async () => {
		const dir = await openDialog({
			directory: true,
			title: "选择要打开的文件夹",
		});
		if (typeof dir === "string") {
			try {
				// 已有工作区时新开窗口，不替换当前（M11）
				await openWorkspace(dir);
			} catch (e) {
				await failDialog("打开目录失败", e);
			}
		}
	};

	const onRowClick = (row: FlatRow) => {
		if (row.node.isDir) void toggleExpand(row.node.path);
		else void openFile(row.node.path);
	};

	const onRowContextMenu = (e: React.MouseEvent, row: FlatRow) => {
		e.preventDefault();
		e.stopPropagation();
		setMenu({ x: e.clientX, y: e.clientY, node: row.node });
	};

	const runMenuAction = async (action: string, node: TreeNode) => {
		setMenu(null);
		const parent = node.isDir ? node.path : parentOf(node.path);
		switch (action) {
			case "open":
				if (node.isDir) void toggleExpand(node.path);
				else void openFile(node.path);
				break;
			case "reader":
				// 阅读模式打开（无章节标题的 txt 也以整本单章打开）
				if (!node.isDir) {
					const ts = useTabsStore.getState();
					await ts.openInReader(node.path);
				}
				break;
			case "copyPath": {
				// 复制完整路径到剪贴板（localhost/asset 上下文为 secure context）
				try {
					await navigator.clipboard.writeText(node.path);
				} catch {
					const ta = document.createElement("textarea");
					ta.value = node.path;
					document.body.appendChild(ta);
					ta.select();
					document.execCommand("copy");
					ta.remove();
				}
				break;
			}
			case "newfile":
			case "newdir": {
				const isDir = action === "newdir";
				const r = await showDialog({
					title: isDir ? "新建文件夹" : "新建文件",
					inputLabel: isDir ? "文件夹名" : "文件名",
					buttons: [
						{ id: "ok", label: "创建", danger: false },
						{ id: "cancel", label: "取消", danger: false },
					],
				});
				if (r.button !== "ok" || !r.input.trim()) break;
				try {
					await invoke("create_file", {
						path: node.path + "\\" + r.input.trim(),
						isDir,
					});
				} catch (e) {
					await failDialog("创建失败", e);
				}
				await refreshDir(node.path);
				break;
			}
			case "rename": {
				const r = await showDialog({
					title: "重命名",
					inputLabel: "新名称",
					initialInput: node.name,
					buttons: [
						{ id: "ok", label: "重命名", danger: false },
						{ id: "cancel", label: "取消", danger: false },
					],
				});
				if (r.button !== "ok" || !r.input.trim()) break;
				try {
					await invoke("rename_path", {
						path: node.path,
						newName: r.input.trim(),
					});
				} catch (e) {
					await failDialog("重命名失败", e);
				}
				await refreshDir(parent);
				break;
			}
			case "delete": {
				const r = await showDialog({
					title: "删除",
					message: `确定删除「${node.name}」？${
						node.isDir ? "目录内所有内容都会被删除。" : ""
					}`,
					buttons: [
						{ id: "ok", label: "删除", danger: true },
						{ id: "cancel", label: "取消", danger: false },
					],
				});
				if (r.button !== "ok") break;
				try {
					await invoke("delete_path", { path: node.path });
				} catch (e) {
					await failDialog("删除失败", e);
				}
				// 关闭受影响标签（不弹确认，文件已删）
				const affected = useTabsStore
					.getState()
					.tabs.filter(
						(t) => t.path === node.path || t.path.startsWith(node.path + "\\"),
					);
				for (const t of affected) await closeTab(t.path);
				await refreshDir(parent);
				break;
			}
			case "reveal":
				void revealItemInDir(node.path);
				break;
			case "refresh":
				if (node.isDir && node.loaded) await refreshDir(node.path);
				else await refreshRoot();
				break;
		}
	};

	const isDirRow = menu?.node.isDir ?? false;
	const isTxtFile = !menu?.node.isDir && /\.txt$/i.test(menu?.node.path ?? "");
	const menuItems: {
		id: string;
		label: string;
		danger?: boolean;
		sep?: boolean;
	}[] = [
		{ id: "open", label: "打开" },
		...(isTxtFile ? [{ id: "reader", label: "以阅读模式打开", sep: true }] : []),
		{ id: "copyPath", label: "复制路径" },
		{ id: "newfile", label: "新建文件" },
		{ id: "newdir", label: "新建文件夹" },
		{ id: "rename", label: "重命名" },
		{ id: "delete", label: "删除", danger: true },
		{ id: "reveal", label: "在资源管理器中显示" },
		{ id: "refresh", label: isDirRow ? "刷新此目录" : "刷新根目录" },
	];

	return (
		<div className="filetree">
			<div className="filetree-header">
				<span className="filetree-title" title={rootName}>
					{rootName || "未打开目录"}
				</span>
				<button
					className="icon-btn"
					onClick={pickFolder}
					title="打开文件夹 (Ctrl+O)"
				>
					📂
				</button>
				<button
					className="icon-btn"
					onClick={() => void refreshRoot()}
					title="刷新"
					disabled={!root}
				>
					🔄
				</button>
			</div>

			{!root ? null : (
				<div className="filetree-scroll" ref={parentRef}>
					<div
						style={{
							height: virtualizer.getTotalSize(),
							width: "100%",
							position: "relative",
						}}
					>
						{virtualizer.getVirtualItems().map((vi) => {
							const row = rows[vi.index];
							const active = row.node.path === activePath;
							return (
								<div
									key={row.node.path}
									className={
										"ft-row" + (active ? " active" : "") + (row.node.isDir ? " dir" : "")
									}
									style={{
										position: "absolute",
										top: 0,
										left: 0,
										width: "100%",
										height: vi.size,
										transform: `translateY(${vi.start}px)`,
										paddingLeft: 8 + row.depth * 14,
									}}
									onClick={() => onRowClick(row)}
									onContextMenu={(e) => onRowContextMenu(e, row)}
									title={row.node.path}
								>
									<span className="ft-icon">
										{row.node.isDir
											? row.expanded
												? "📂"
												: "📁"
											: fileIcon(row.node.path, false)}
									</span>
									<span className="ft-name">{row.node.name}</span>
									{row.node.loading && <span className="ft-loading">⏳</span>}
									{!row.node.isDir && row.node.size > 0 && (
										<span className="ft-size">{formatSize(row.node.size)}</span>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{menu && (
				<div
					className="context-menu"
					style={{ left: menu.x, top: menu.y }}
					onContextMenu={(e) => e.preventDefault()}
				>
					{menuItems.map((m) => (
						<div
							key={m.id}
							className={"context-menu-item" + (m.danger ? " danger" : "")}
							onClick={() => void runMenuAction(m.id, menu.node)}
						>
							{m.label}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
