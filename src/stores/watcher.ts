//! fs-event 监听与分派（Rust notify → 前端）
//! - modify：打开中且未改 → 自动重载；已改 → 提示条（externalModified 持久标记，R-13）
//! - remove：目录树父层刷新 + 打开中标签标记已删除
//! - rename：目录树刷新 + 打开中标签路径迁移
//! - create：目录树父层刷新（保存重建文件也走这里）
//! - R-23：目录树刷新按「父目录」聚合去重，避免事件风暴下逐条全树遍历

import { listen } from "@tauri-apps/api/event";
import { useTabsStore } from "./tabs";
import { useTreeStore } from "./tree";

export interface FsEvent {
	path: string;
	kind: "create" | "modify" | "remove" | "rename";
	from_path?: string;
}

/** 注册全局监听，返回反注册函数（App 挂载时调用一次） */
export async function initWatcher(): Promise<() => void> {
	return listen<FsEvent[]>("fs-event", (e) => {
		void handleFsEvents(e.payload);
	});
}

function dirname(p: string): string {
	return p.replace(/[\\/][^\\/]*$/, "");
}

async function handleFsEvents(events: FsEvent[]) {
	// 目录树刷新目标（父目录去重）
	const refreshDirs = new Set<string>();

	for (const ev of events) {
		// 目录树：收集需要刷新的父目录
		if (ev.kind === "create" || ev.kind === "remove") {
			refreshDirs.add(dirname(ev.path));
		} else if (ev.kind === "rename") {
			if (ev.from_path) refreshDirs.add(dirname(ev.from_path));
			refreshDirs.add(dirname(ev.path));
		}

		const s = useTabsStore.getState();
		if (ev.kind === "modify") {
			const doc = s.tabs.find((t) => t.path === ev.path);
			if (!doc) continue;
			if (doc.status === "ready") {
				void s.reload(ev.path); // 本地未改 → 自动重载
			} else if (doc.status === "dirty") {
				s.markExternalChanged(ev.path); // 本地已改 → 提示（保留分叉标记）
			}
			continue;
		}
		if (ev.kind === "remove") {
			for (const d of s.tabs) {
				if (d.path === ev.path || d.path.startsWith(ev.path + "\\")) {
					s.markDeleted(d.path);
				}
			}
			continue;
		}
		if (ev.kind === "rename" && ev.from_path) {
			let moved = false;
			for (const d of s.tabs) {
				if (d.path === ev.from_path) {
					s.renameTab(d.path, ev.path);
					moved = true;
				} else if (d.path.startsWith(ev.from_path + "\\")) {
					// 目录改名：子路径整体迁移
					s.renameTab(d.path, ev.path + d.path.slice(ev.from_path.length));
					moved = true;
				}
			}
			if (moved) continue;
			// 原子保存（外部编辑器：写临时文件 + 改名覆盖）→ 按 modify 处理
			const doc = s.tabs.find((t) => t.path === ev.path);
			if (doc) {
				if (doc.status === "ready") void s.reload(ev.path);
				else if (doc.status === "dirty") s.markExternalChanged(ev.path);
			}
		}
	}

	// R-23：整批父目录一次刷新（去重 + 仅命中已加载层）
	if (refreshDirs.size > 0) {
		useTreeStore.getState().refreshIfLoadedDirs([...refreshDirs]);
	}
}
