import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	build: {
		target: "chrome105",
		outDir: "dist-test",
		emptyOutDir: true,
		rollupOptions: {
			input: "test-render.html",
		},
	},
});
