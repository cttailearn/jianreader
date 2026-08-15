//! 小说模式 Ctrl+S 入口：保存当前章（回写 + 重解析 + 标签状态同步）

import { useNovelStore } from "./novel";
import { useTabsStore } from "./tabs";

export async function saveActiveNovel(path?: string): Promise<boolean> {
	const st = useNovelStore.getState();
	const target = path ?? st.activePath;
	if (!target) return true;
	try {
		const ok = await st.saveChapter(target);
		// 保存后同步标签状态（dirty 清除）
		if (ok) useTabsStore.getState().setNovelDirty(target, false);
		return ok;
	} catch (e) {
		console.error("小说章节保存失败:", e);
		return false;
	}
}
