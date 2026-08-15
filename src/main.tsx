import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/global.css";
import { useTabsStore } from "./stores/tabs";
import { useTreeStore } from "./stores/tree";
import { useMdStore } from "./stores/md";
import { useNovelStore } from "./stores/novel";

// 开发/验收钩子：CDP 端到端测试可直接驱动 store（绕过原生对话框）
if (import.meta.env.DEV) {
	(window as unknown as Record<string, unknown>).__stores = {
		tabs: useTabsStore,
		tree: useTreeStore,
		md: useMdStore,
		novel: useNovelStore,
	};
}

// 注意：不用 StrictMode —— Milkdown Crepe 是重量级命令式编辑器，
// StrictMode 的 dev 双挂载会导致双实例竞态（大纲/api 被旧实例 destroy 覆盖）
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<App />,
);
