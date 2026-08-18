//! 打开目录：当前窗口无工作区 → 原地打开；已有工作区 → 新开窗口（不替换当前，M11）

import { useTreeStore } from "../stores/tree";

export async function openWorkspace(path: string): Promise<void> {
	const tree = useTreeStore.getState();
	const cur = tree.rootPath;
	if (!cur) {
		await tree.openRoot(path);
		return;
	}
	if (cur.toLowerCase() === path.toLowerCase()) return; // 相同目录：忽略
	const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
	await new WebviewWindow("workspace-" + Date.now(), {
		url: "index.html?root=" + encodeURIComponent(path),
		title: "简阅",
		width: 1280,
		height: 800,
		minWidth: 900,
		minHeight: 600,
		center: true,
		decorations: false,
		transparent: true,
		shadow: true,
	});
}
