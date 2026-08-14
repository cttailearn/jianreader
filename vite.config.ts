import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 桌面应用专用 Vite 配置
export default defineConfig({
	plugins: [react()],

	// 防止 Vite 清屏把 Rust 侧日志刷掉
	clearScreen: false,

	// Tauri 约定端口；1420 在本机被 Windows 排除范围(1357-1456)保留，改用 5173
	server: {
		port: 5173,
		strictPort: true,
		watch: {
			// 忽略 Rust 目录，避免 cargo 编译产物触发前端重载
			ignored: ["**/src-tauri/**"],
		},
	},

	build: {
		// WebView2 支持范围（Win10 1809+ 的 Chromium 基线）
		target: "chrome105",
		chunkSizeWarningLimit: 800,
	},
});
