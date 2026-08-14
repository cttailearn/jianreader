//! fs-event 监听与分派（Rust notify → 前端）
//! - modify：打开中且未改 → 自动重载；已改 → 提示条
//! - remove：目录树父层刷新 + 打开中标签标记已删除
//! - rename：目录树刷新 + 打开中标签路径迁移
//! - create：目录树父层刷新（保存重建文件也走这里）

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

async function handleFsEvents(events: FsEvent[]) {
	for (const ev of events) {
		// 目录树增量更新（父目录已加载才刷新）
		useTreeStore.getState().applyFsEvent(ev);

		const s = useTabsStore.getState();
		if (ev.kind === "modify") {
			const doc = s.tabs.find((t) => t.path === ev.path);
			if (!doc) continue;
			if (doc.status === "ready") {
				void s.reload(ev.path); // 本地未改 → 自动重载
			} else if (doc.status === "dirty") {
				s.markExternalChanged(ev.path); // 本地已改 → 提示
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
}
