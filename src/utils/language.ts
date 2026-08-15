//! 扩展名 → 语言 ID + 按需动态加载器
//! 语言包全部 dynamic import，首屏不打包；打开文件时才拉对应语言包

import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

type Loader = () => Promise<Extension>;

const JAVASCRIPT = () =>
	import("@codemirror/lang-javascript").then((m) => m.javascript());
const TS = () =>
	import("@codemirror/lang-javascript").then((m) =>
		m.javascript({ typescript: true }),
	);
const JSX = () =>
	import("@codemirror/lang-javascript").then((m) =>
		m.javascript({ jsx: true }),
	);
const TSX = () =>
	import("@codemirror/lang-javascript").then((m) =>
		m.javascript({ jsx: true, typescript: true }),
	);
const PYTHON = () => import("@codemirror/lang-python").then((m) => m.python());
const JAVA = () => import("@codemirror/lang-java").then((m) => m.java());
const CPP = () => import("@codemirror/lang-cpp").then((m) => m.cpp());
const CSS = () => import("@codemirror/lang-css").then((m) => m.css());
const HTML = () => import("@codemirror/lang-html").then((m) => m.html());
const JSON_LANG = () => import("@codemirror/lang-json").then((m) => m.json());
const MARKDOWN = () =>
	import("@codemirror/lang-markdown").then((m) => m.markdown());
const RUST = () => import("@codemirror/lang-rust").then((m) => m.rust());
const GO = () => import("@codemirror/lang-go").then((m) => m.go());
const SQL = () => import("@codemirror/lang-sql").then((m) => m.sql());
const YAML = () => import("@codemirror/lang-yaml").then((m) => m.yaml());
const XML = () => import("@codemirror/lang-xml").then((m) => m.xml());
const PHP = () => import("@codemirror/lang-php").then((m) => m.php());
const VUE = () => import("@codemirror/lang-vue").then((m) => m.vue());

// legacy-modes 静态枚举（Vite 的 import.meta.glob 不接受裸包名；
// 显式列出实际用到的 16 个模式文件，可静态分析 + 按需分包）
const LEGACY_MODULES = {
	clike: () => import("@codemirror/legacy-modes/mode/clike"),
	swift: () => import("@codemirror/legacy-modes/mode/swift"),
	ruby: () => import("@codemirror/legacy-modes/mode/ruby"),
	lua: () => import("@codemirror/legacy-modes/mode/lua"),
	perl: () => import("@codemirror/legacy-modes/mode/perl"),
	r: () => import("@codemirror/legacy-modes/mode/r"),
	sass: () => import("@codemirror/legacy-modes/mode/sass"),
	css: () => import("@codemirror/legacy-modes/mode/css"),
	toml: () => import("@codemirror/legacy-modes/mode/toml"),
	properties: () => import("@codemirror/legacy-modes/mode/properties"),
	shell: () => import("@codemirror/legacy-modes/mode/shell"),
	powershell: () => import("@codemirror/legacy-modes/mode/powershell"),
} as const;

const legacy =
	(mod: string, name: string): Loader =>
	async () => {
		const loader = LEGACY_MODULES[mod as keyof typeof LEGACY_MODULES];
		if (!loader) throw new Error(`unknown legacy mode: ${mod}`);
		const m = (await loader()) as Record<string, unknown>;
		return new LanguageSupport(
			StreamLanguage.define(m[name] as StreamParser<unknown>),
		);
	};

/** 扩展名（小写，无点）→ 语言名 + 加载器 */
const LANG_MAP: Record<string, { name: string; load: Loader }> = {
	// JavaScript 家族
	js: { name: "JavaScript", load: JAVASCRIPT },
	mjs: { name: "JavaScript", load: JAVASCRIPT },
	cjs: { name: "JavaScript", load: JAVASCRIPT },
	jsx: { name: "JavaScript JSX", load: JSX },
	ts: { name: "TypeScript", load: TS },
	mts: { name: "TypeScript", load: TS },
	cts: { name: "TypeScript", load: TS },
	tsx: { name: "TypeScript JSX", load: TSX },

	// 系统语言
	py: { name: "Python", load: PYTHON },
	java: { name: "Java", load: JAVA },
	c: { name: "C", load: CPP },
	h: { name: "C", load: CPP },
	cpp: { name: "C++", load: CPP },
	cc: { name: "C++", load: CPP },
	cxx: { name: "C++", load: CPP },
	hpp: { name: "C++", load: CPP },
	go: { name: "Go", load: GO },
	rs: { name: "Rust", load: RUST },
	cs: { name: "C#", load: legacy("clike", "csharp") },
	kt: { name: "Kotlin", load: legacy("clike", "kotlin") },
	scala: { name: "Scala", load: legacy("clike", "scala") },
	swift: { name: "Swift", load: legacy("swift", "swift") },
	php: { name: "PHP", load: PHP },
	rb: { name: "Ruby", load: legacy("ruby", "ruby") },
	lua: { name: "Lua", load: legacy("lua", "lua") },
	pl: { name: "Perl", load: legacy("perl", "perl") },
	r: { name: "R", load: legacy("r", "r") },
	dart: { name: "Dart", load: legacy("clike", "dart") },
	vue: { name: "Vue", load: VUE },

	// 前端
	css: { name: "CSS", load: CSS },
	scss: { name: "SCSS", load: legacy("sass", "sass") },
	sass: { name: "Sass", load: legacy("sass", "sass") },
	less: { name: "Less", load: legacy("css", "less") },
	html: { name: "HTML", load: HTML },
	htm: { name: "HTML", load: HTML },
	xml: { name: "XML", load: XML },
	svg: { name: "XML", load: XML },

	// 数据 / 配置
	json: { name: "JSON", load: JSON_LANG },
	yml: { name: "YAML", load: YAML },
	yaml: { name: "YAML", load: YAML },
	toml: { name: "TOML", load: legacy("toml", "toml") },
	ini: { name: "INI", load: legacy("properties", "properties") },
	conf: { name: "Config", load: legacy("properties", "properties") },
	properties: { name: "Properties", load: legacy("properties", "properties") },
	env: { name: "Env", load: legacy("shell", "shell") },

	// 数据库 / 文档
	sql: { name: "SQL", load: SQL },
	md: { name: "Markdown", load: MARKDOWN },
	markdown: { name: "Markdown", load: MARKDOWN },
	mdx: { name: "Markdown", load: MARKDOWN },
	txt: {
		name: "Plain Text",
		load: async () => [] as unknown as LanguageSupport,
	},

	// 脚本
	sh: { name: "Shell", load: legacy("shell", "shell") },
	bash: { name: "Shell", load: legacy("shell", "shell") },
	zsh: { name: "Shell", load: legacy("shell", "shell") },
	fish: { name: "Shell", load: legacy("shell", "shell") },
	bat: { name: "Batch", load: legacy("shell", "shell") },
	cmd: { name: "Batch", load: legacy("shell", "shell") },
	ps1: { name: "PowerShell", load: legacy("powershell", "powerShell") },
};

export interface LanguageInfo {
	id: string; // 扩展名
	name: string; // 显示名
	load: Loader;
}

/** 按扩展名查语言；未知返回 null（纯文本模式） */
export function getLanguage(path: string): LanguageInfo | null {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const entry = LANG_MAP[ext];
	if (!entry) return null;
	return { id: ext, name: entry.name, load: entry.load };
}

/** 图片文件判定（M7：以图片查看器打开，不做文本解码） */
const IMAGE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"ico",
	"avif",
	"tif",
	"tiff",
]);

export function isImagePath(path: string): boolean {
	return IMAGE_EXTS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

/** 文件名 → 文件图标（目录树/标签页用） */
export function fileIcon(path: string, isDir: boolean): string {
	if (isDir) return "📁";
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		js: "🟨",
		mjs: "🟨",
		cjs: "🟨",
		jsx: "🟨",
		ts: "🟦",
		mts: "🟦",
		tsx: "🟦",
		py: "🐍",
		java: "☕",
		c: "🔵",
		h: "🔵",
		cpp: "🔵",
		cc: "🔵",
		hpp: "🔵",
		go: "🐹",
		rs: "🦀",
		cs: "🟪",
		kt: "🟪",
		swift: "🟧",
		css: "🎨",
		scss: "🎨",
		sass: "🎨",
		less: "🎨",
		html: "🟧",
		htm: "🟧",
		json: "🔷",
		yml: "🔶",
		yaml: "🔶",
		toml: "🔶",
		xml: "🔶",
		sql: "🗄️",
		md: "📘",
		markdown: "📘",
		mdx: "📘",
		txt: "📄",
		sh: "💻",
		bash: "💻",
		bat: "💻",
		ps1: "💻",
		png: "🖼️",
		jpg: "🖼️",
		jpeg: "🖼️",
		gif: "🖼️",
		webp: "🖼️",
		svg: "🖼️",
		bmp: "🖼️",
		ico: "🖼️",
		avif: "🖼️",
	};
	return map[ext] ?? "📄";
}
