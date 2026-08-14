//! 外部修改提示条：dirty 文档被外部改写时出现
//! [重新加载] 丢弃本地修改读盘；[保留本地] 回到 dirty（保存会覆盖外部修改）

import { useTabsStore } from "../stores/tabs";

export default function ExternalChangeBar({ path }: { path: string }) {
	const reload = useTabsStore((s) => s.reload);
	const keepLocal = useTabsStore((s) => s.keepLocal);

	return (
		<div className="external-change-bar">
			<span className="ecb-icon">⚠️</span>
			<span className="ecb-text">文件已被外部修改</span>
			<button className="ecb-btn" onClick={() => void reload(path)}>
				重新加载
			</button>
			<button className="ecb-btn" onClick={() => keepLocal(path)}>
				保留本地
			</button>
		</div>
	);
}
