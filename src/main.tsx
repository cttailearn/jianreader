import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/global.css";
import { useTabsStore } from "./stores/tabs";
import { useTreeStore } from "./stores/tree";

// 开发/验收钩子：CDP 端到端测试可直接驱动 store（绕过原生对话框）
if (import.meta.env.DEV) {
	(window as unknown as Record<string, unknown>).__stores = {
		tabs: useTabsStore,
		tree: useTreeStore,
	};
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
