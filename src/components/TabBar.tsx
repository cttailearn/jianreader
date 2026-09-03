//! 多标签页：激活/关闭/中键关闭/dirty 圆点（Ctrl+Tab 循环已并入 App 全局快捷键，M9）

import { useTabsStore } from "../stores/tabs";
import { fileIcon } from "../utils/language";

export default function TabBar() {
	const tabs = useTabsStore((s) => s.tabs);
	const activePath = useTabsStore((s) => s.activePath);
	const activate = useTabsStore((s) => s.activate);
	const close = useTabsStore((s) => s.close);

	if (tabs.length === 0) return <div className="tabbar tabbar-empty" />;

	return (
		<div className="tabbar">
			<div className="tabbar-scroll">
				{tabs.map((t) => (
					<div
						key={t.path}
						className={"tab" + (t.path === activePath ? " active" : "")}
						role="tab"
						aria-selected={t.path === activePath}
						onClick={() => activate(t.path)}
						onAuxClick={(e) => {
							if (e.button === 1) {
								e.preventDefault();
								void close(t.path);
							}
						}}
						title={t.path}
					>
						<span className="tab-icon">{fileIcon(t.path, false)}</span>
						<span className="tab-name">{t.name}</span>
						{t.status === "dirty" && <span className="tab-dirty">●</span>}
						{t.status === "loading" && <span className="tab-loading">⏳</span>}
						<button
							className="tab-close"
							title="关闭 (Ctrl+W)"
							aria-label={`关闭标签 ${t.name}`}
							onClick={(e) => {
								e.stopPropagation();
								void close(t.path);
							}}
						>
							×
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
