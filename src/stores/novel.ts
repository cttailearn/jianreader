//! 小说模式状态：章节表、当前章、阅读设置、书签续读
//!
//! - 章节表来自 Rust scan_chapters（流式扫描，50MB < 30ms）
//! - 正文按章懒加载（read_chapter），内存只留当前章 ± 邻章
//! - 阅读设置按书籍绝对路径存 localStorage（每本书独立记忆）
//! - 续读：上次章节 + 章内滚动位置，再次打开提示「继续阅读」

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface ChapterInfo {
	title: string;
	/** 章节起始字节偏移 */
	start: number;
	/** 章节结束字节偏移（下一章 start） */
	end: number;
	/** 1 = 卷/部/集/篇，2 = 章/节/回等 */
	level: number;
}

export interface ScanResult {
	chapters: ChapterInfo[];
	total_bytes: number;
	is_novel: boolean;
	encoding: string;
	has_bom: boolean;
	eol: string;
	/** 磁盘只读属性（小说标签同样禁止编辑） */
	readonly: boolean;
}

/** 阅读设置（每本书独立记忆） */
export interface ReadingSettings {
	fontSize: number; // 14~36
	lineHeight: number; // 1.5~2.5
	letterSpacing: number; // 0~0.3em
	paraSpacing: number; // 0~2em
	contentWidth: number; // 60~80ch
	/** 背景：米黄护眼（默认）/ 浅色 / 浅灰 / 夜间纯黑（与 app 主题解耦） */
	bg: "sepia" | "light" | "gray" | "dark";
}

export const DEFAULT_SETTINGS: ReadingSettings = {
	fontSize: 19,
	lineHeight: 2.0,
	letterSpacing: 0.02,
	paraSpacing: 0.8,
	contentWidth: 70,
	bg: "sepia",
};

interface NovelBookState {
	path: string;
	scan: ScanResult;
	/** 当前章索引 */
	chapterIdx: number;
	/** 当前章正文 */
	chapterText: string;
	/** 章节编辑状态：immutable 原文（未保存回写前的原始文本） */
	origText: string;
	editing: boolean;
	loading: boolean;
	/** 当前章滚动位置（onScroll 实时更新，书签续读用） */
	scrollPos: number;
	/** 每章滚动位置记忆（chapterIdx → scrollTop，切章恢复） */
	scrollMap: Map<number, number>;
	settings: ReadingSettings;
	/** 各章 dirty 集合（章索引） */
	dirtySet: Set<number>;
}

interface NovelState {
	books: Map<string, NovelBookState>;
	activePath: string | null;
	/** 加载书籍（扫描章节表）→ 返回是否进入小说模式；force 强制进入（手动「阅读模式」） */
	loadBook: (path: string, force?: boolean) => Promise<boolean>;
	unloadBook: (path: string) => void;
	/** 外部修改后重扫章节表 + 重读当前章（清 dirty） */
	reloadBook: (path: string) => Promise<void>;
	/** 文件改名：book 按新路径迁移（章节表/设置/书签键同步） */
	moveBook: (fromPath: string, toPath: string) => void;
	/** 切到指定章（懒加载正文，记忆/恢复该章滚动位置） */
	gotoChapter: (path: string, idx: number) => Promise<void>;
	/** 更新当前章编辑内容 */
	setChapterText: (path: string, text: string) => void;
	setEditing: (path: string, editing: boolean) => void;
	setScrollPos: (path: string, pos: number) => void;
	updateSettings: (path: string, patch: Partial<ReadingSettings>) => void;
	/** 保存当前章（按 offset 写回 + 重解析章节表） */
	saveChapter: (path: string) => Promise<boolean>;
	/** 标记某章 dirty（查找替换全书范围用） */
	markDirty: (path: string, idx: number) => void;
	/** 记录续读位置 */
	markReading: (path: string, idx: number) => void;
}

const SETTINGS_KEY = "jianyue-novel-settings-v1";
const BOOKMARK_KEY = "jianyue-novel-bookmarks-v1";

function loadSettings(path: string): ReadingSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (raw) {
			const map = JSON.parse(raw) as Record<string, ReadingSettings>;
			if (map[path]) return { ...DEFAULT_SETTINGS, ...map[path] };
		}
	} catch {
		/* ignore */
	}
	return { ...DEFAULT_SETTINGS };
}

export function saveSettings(path: string, s: ReadingSettings): void {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, ReadingSettings>) : {};
		map[path] = s;
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(map));
	} catch {
		/* ignore */
	}
}

export interface Bookmark {
	chapterIdx: number;
	scrollPos: number;
	updatedAt: number;
}

export function loadBookmark(path: string): Bookmark | null {
	try {
		const raw = localStorage.getItem(BOOKMARK_KEY);
		if (raw) {
			const map = JSON.parse(raw) as Record<string, Bookmark>;
			return map[path] ?? null;
		}
	} catch {
		/* ignore */
	}
	return null;
}

export function saveBookmark(path: string, b: Bookmark): void {
	try {
		const raw = localStorage.getItem(BOOKMARK_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, Bookmark>) : {};
		map[path] = b;
		localStorage.setItem(BOOKMARK_KEY, JSON.stringify(map));
	} catch {
		/* ignore */
	}
}

/** 剥掉章节正文首行的标题（读回的章节文本 = 标题行 + 正文） */
function stripHeadingLine(text: string): string {
	const idx = text.indexOf("\n");
	if (idx < 0) return "";
	const rest = text.slice(idx + 1);
	// 兼容 \r\n：\n 已含于 slice 后（剥到 \n 之后即可）
	return rest.startsWith("\r") ? rest : rest;
}

/** 组合写回内容：标题行 + 正文，保证与下一章之间有换行分隔 */
function composeChapter(title: string, body: string): string {
	const b = body.endsWith("\n") ? body : `${body}\n`;
	return `${title}\n${b}`;
}

export const useNovelStore = create<NovelState>((set, get) => ({
	books: new Map(),
	activePath: null,

	loadBook: async (path, force = false) => {
		try {
			const scan = await invoke<ScanResult>("scan_chapters", { path });
			if (!scan.is_novel && !(force && scan.chapters.length >= 1)) return false;
			const settings = loadSettings(path);
			const bookmark = loadBookmark(path);
			const book: NovelBookState = {
				path,
				scan,
				chapterIdx: bookmark?.chapterIdx ?? 0,
				chapterText: "",
				origText: "",
				editing: false,
				loading: false,
				scrollPos: bookmark?.scrollPos ?? 0,
				scrollMap: new Map(),
				settings,
				dirtySet: new Set(),
			};
			set((s) => {
				const books = new Map(s.books);
				books.set(path, book);
				return { books, activePath: path };
			});
			await get().gotoChapter(path, book.chapterIdx);
			return true;
		} catch {
			return false;
		}
	},

	unloadBook: (path) => {
		const b = get().books.get(path);
		if (b) get().markReading(path, b.chapterIdx);
		set((s) => {
			const books = new Map(s.books);
			books.delete(path);
			return {
				books,
				activePath: s.activePath === path ? null : s.activePath,
			};
		});
	},

	reloadBook: async (path) => {
		const book = get().books.get(path);
		if (!book) return;
		let scan: ScanResult;
		try {
			scan = await invoke<ScanResult>("scan_chapters", { path });
		} catch {
			return; // 文件已不可读（随后 remove 事件会标记 deleted）
		}
		if (scan.chapters.length === 0) return;
		const idx = Math.min(book.chapterIdx, scan.chapters.length - 1);
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) {
				books.set(path, {
					...cur,
					scan,
					chapterIdx: idx,
					editing: false,
					loading: true,
					chapterText: "",
					origText: "",
					scrollPos: 0,
					dirtySet: new Set(),
				});
			}
			return { books };
		});
		const ch = scan.chapters[idx];
		const text = await invoke<string>("read_chapter", {
			path,
			start: ch.start,
			end: ch.end,
			encoding: scan.encoding,
		}).catch(() => "");
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) {
				books.set(path, {
					...cur,
					chapterText: stripHeadingLine(text),
					origText: stripHeadingLine(text),
					loading: false,
				});
			}
			return { books };
		});
	},

	moveBook: (fromPath, toPath) =>
		set((s) => {
			const books = new Map(s.books);
			const b = books.get(fromPath);
			if (b) {
				books.delete(fromPath);
				books.set(toPath, { ...b, path: toPath });
			}
			return {
				books,
				activePath: s.activePath === fromPath ? toPath : s.activePath,
			};
		}),

	gotoChapter: async (path, idx) => {
		const book = get().books.get(path);
		if (!book) return;
		const ch = book.scan.chapters[idx];
		if (!ch) return;
		// 同章重入跳过（loadBook 首次进入时正文为空，仍需加载）
		if (idx === book.chapterIdx && !book.loading && book.chapterText !== "") return;
		// 离开旧章：当前滚动位置存入 scrollMap
		const scrollMap = new Map(book.scrollMap);
		scrollMap.set(book.chapterIdx, book.scrollPos);
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) {
				books.set(path, {
					...cur,
					chapterIdx: idx,
					chapterText: "",
					origText: "",
					editing: false,
					loading: true,
					scrollPos: scrollMap.get(idx) ?? 0,
					scrollMap,
				});
			}
			return { books };
		});
		// 邻章预取（下一章，提升翻页体验）
		const next = book.scan.chapters[idx + 1];
		if (next) {
			void invoke<string>("read_chapter", {
				path,
				start: next.start,
				end: next.end,
				encoding: book.scan.encoding,
			}).catch(() => {});
		}
		const text = await invoke<string>("read_chapter", {
			path,
			start: ch.start,
			end: ch.end,
			encoding: book.scan.encoding,
		}).catch(() => "");
		// 剥掉首行标题（阅读视图标题单独渲染）→ store 只存正文，
		// 保存时再由 saveChapter 拼回标题行（避免编辑态丢失标题）
		const body = stripHeadingLine(text);
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur && cur.chapterIdx === idx) {
				books.set(path, {
					...cur,
					chapterText: body,
					origText: body,
					loading: false,
				});
			}
			return { books };
		});
		// 记录续读位置（章切换即存书签）
		get().markReading(path, idx);
	},

	setChapterText: (path, text) =>
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (!cur) return s;
			const dirtySet = new Set(cur.dirtySet);
			dirtySet.add(cur.chapterIdx);
			books.set(path, { ...cur, chapterText: text, dirtySet });
			return { books };
		}),

	setEditing: (path, editing) =>
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (!cur) return s;
			books.set(path, { ...cur, editing });
			return { books };
		}),

	setScrollPos: (path, pos) =>
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (!cur) return s;
			books.set(path, { ...cur, scrollPos: pos });
			return { books };
		}),

	updateSettings: (path, patch) => {
		const book = get().books.get(path);
		if (!book) return;
		const next = { ...book.settings, ...patch };
		saveSettings(path, next);
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) books.set(path, { ...cur, settings: next });
			return { books };
		});
	},

	saveChapter: async (path) => {
		const book = get().books.get(path);
		if (!book) return false;
		const ch = book.scan.chapters[book.chapterIdx];
		if (!ch) return false;
		// 写回：标题行 + 正文（store 只存正文，这里拼回标题行）
		const newSize = await invoke<number>("write_chapter", {
			path,
			start: ch.start,
			end: ch.end,
			content: composeChapter(ch.title, book.chapterText),
			encoding: book.scan.encoding,
			hasBom: book.scan.has_bom,
			eol: book.scan.eol,
		});
		// 保存后重解析章节表（章节结构可能已变），保持当前章定位
		const scan = await invoke<ScanResult>("scan_chapters", { path });
		// 定位最近的章（当前章标题/偏移可能已变）
		const curTitle = ch.title;
		let idx = scan.chapters.findIndex((c) => c.title === curTitle);
		if (idx < 0) idx = 0;
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) {
				books.set(path, {
					...cur,
					scan,
					chapterIdx: idx,
					origText: cur.chapterText,
					dirtySet: new Set(),
				});
			}
			return { books };
		});
		// 重读当前章正文（offset 已变）
		const c2 = scan.chapters[idx];
		if (c2) {
			const text = await invoke<string>("read_chapter", {
				path,
				start: c2.start,
				end: c2.end,
				encoding: scan.encoding,
			});
			set((s) => {
				const books = new Map(s.books);
				const cur = books.get(path);
				if (cur) {
					const body = stripHeadingLine(text);
					books.set(path, {
						...cur,
						chapterText: body,
						origText: body,
						editing: false,
					});
				}
				return { books };
			});
		}
		void newSize;
		return true;
	},

	markDirty: (path, idx) =>
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (!cur) return s;
			const dirtySet = new Set(cur.dirtySet);
			dirtySet.add(idx);
			books.set(path, { ...cur, dirtySet });
			return { books };
		}),

	markReading: (path, idx) => {
		const book = get().books.get(path);
		if (!book) return;
		saveBookmark(path, {
			chapterIdx: idx,
			scrollPos: book.scrollPos,
			updatedAt: Date.now(),
		});
	},
}));
