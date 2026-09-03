// 防主题闪烁：在 React 渲染前同步套用持久化主题。
// 与 theme store 共用键逻辑（含旧键 tve-theme 兼容）。独立小模块，避免内联脚本被 CSP 拦截。
const KEY = "jianyue-theme";
const LEGACY = "tve-theme";
try {
	const v = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY);
	if (v === "dark") document.documentElement.dataset.theme = "dark";
} catch (e) {
	/* ignore */
}
