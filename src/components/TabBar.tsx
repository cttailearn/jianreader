//! 多标签页：激活/关闭/中键关闭/dirty 圆点/Ctrl+Tab 循环

import { useEffect } from "react";
import { useTabsStore } from "../stores/tabs";
import { fileIcon } from "../utils/language";

export default function TabBar() {
	const tabs = useTabsStore((s) => s.tabs);
	const activePath = useTabsStore((s) => s.activePath);
	const activate = useTabsStore((s) => s.activate);
	const close = useTabsStore((s) => s.close);

	// Ctrl+Tab 循环切换标签
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && !e.shiftKey && e.key === "Tab") {
				e.preventDefault();
				const s = useTabsStore.getState();
				if (s.tabs.length < 2) return;
				const idx = s.tabs.findIndex((t) => t.path === s.activePath);
				s.activate(s.tabs[(idx + 1) % s.tabs.length].path);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	if (tabs.length === 0) return <div className="tabbar tabbar-empty" />;

	return (
		<div className="tabbar">
			<div className="tabbar-scroll">
				{tabs.map((t) => (
					<div
						key={t.path}
						className={"tab" + (t.path === activePath ? " active" : "")}
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
