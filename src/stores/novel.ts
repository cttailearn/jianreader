//! 小说模式状态：章节表、分章草稿、当前章、阅读设置、书签续读
//!
//! R-01（数据安全）核心重设计：
//! - ``drafts: Map<chapterIdx, string>`` 保存各章编辑草稿（权威内容），切章/退出/重载都不丢
//! - ``saveChapter`` 按倒序批量写回全部 dirty 章（倒序保证原始字节偏移在写入全程有效），
//!   写完后重扫章节表、做保存期间冲突检测（R-03）
//! - ``gotoChapter`` 有草稿的章直接展示草稿，无草稿才从磁盘按块懒加载
//! - 编辑/替换前必须完整加载该章（防止把未加载尾巴丢掉的替换）
//!
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
	/** 手动指定文件编码（空 = 自动检测；乱码时切换重载） */
	encoding?: string;
	/** 自定义章节识别正则（空 = 内置规则；仅行首匹配） */
	chapterRegex?: string;
}

/** 可选编码列表（阅读设置切换用） */
export const ENCODING_OPTIONS = [
	"自动检测",
	"UTF-8",
	"GBK",
	"Big5",
	"UTF-16LE",
	"UTF-16BE",
	"Shift_JIS",
	"EUC-KR",
] as const;

export const DEFAULT_SETTINGS: ReadingSettings = {
	fontSize: 19,
	lineHeight: 2.0,
	letterSpacing: 0.02,
	paraSpacing: 0.8,
	contentWidth: 70,
	bg: "sepia",
};

/** 读取某本书的阅读设置（openFile 用于复用扫描时的编码/正则覆盖，R-21） */
export function getReadingSettings(path: string): ReadingSettings {
	return loadSettings(path);
}

/** 章节正文分页块大小（字节） */
const CHAPTER_CHUNK = 256 * 1024;

/** R-20：按章读取走 raw IPC。Rust 返回 UTF-8 原始字节（tauri::ipc::Response），
 *  前端以 TextDecoder 解码 —— 大文本不再经历 JSON 序列化/解析。 */
async function readChapterText(
	path: string,
	start: number,
	end: number,
	encoding: string,
): Promise<string> {
	const buf = await invoke<ArrayBuffer>("read_chapter", {
		path,
		start,
		end,
		encoding,
	});
	return new TextDecoder("utf-8").decode(buf);
}

export { readChapterText };

interface NovelBookState {
	path: string;
	scan: ScanResult;
	/** 当前章索引 */
	chapterIdx: number;
	/** 当前章已加载正文（展示用；含草稿的全部内容或无草稿时的已加载块） */
	chapterText: string;
	/** 各章编辑草稿（按章索引，正文不含标题行）——未保存编辑的权威内容（R-01） */
	drafts: Map<number, string>;
	editing: boolean;
	loading: boolean;
	saving: boolean;
	/** 当前章已加载到的相对字节偏移（相对 ch.start；等于章长表示已完整加载） */
	pageEnd: number;
	/** 分页加载中 */
	paging: boolean;
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
	/** 加载书籍（扫描章节表）→ 返回是否进入小说模式；presetScan 复用 openFile 的扫描结果（R-21） */
	loadBook: (path: string, force?: boolean, presetScan?: ScanResult) => Promise<boolean>;
	unloadBook: (path: string) => void;
	/** 外部修改后重扫章节表 + 重读当前章（清 dirty/草稿——用户已选择「重新加载」= 放弃本地） */
	reloadBook: (path: string) => Promise<void>;
	/** 文件改名：book 按新路径迁移（章节表/设置/书签键同步） */
	moveBook: (fromPath: string, toPath: string) => void;
	/** 切到指定章（有草稿展示草稿，否则懒加载正文，记忆/恢复滚动位置） */
	gotoChapter: (path: string, idx: number) => Promise<void>;
	/** 分页加载当前章下一块（滚动到底自动调用） */
	loadMore: (path: string) => Promise<void>;
	/** 完整加载当前章（编辑/查找替换前调用，保证全文在内存） */
	ensureFullChapter: (path: string) => Promise<void>;
	/** 更新当前章编辑内容 → 写入草稿并标 dirty（R-01） */
	setChapterText: (path: string, text: string) => void;
	setEditing: (path: string, editing: boolean) => void;
	setScrollPos: (path: string, pos: number) => void;
	updateSettings: (path: string, patch: Partial<ReadingSettings>) => void;
	/** 按当前设置（编码/章节正则）重新扫描章节表并重载 */
	reapplyScan: (path: string) => Promise<void>;
	/** 保存全部 dirty 章（R-01：倒序写回 + 重扫 + 冲突检测）→ 返回是否全部保存成功 */
	saveChapter: (path: string) => Promise<boolean>;
	/** 是否有任何未保存修改 */
	hasDirty: (path: string) => boolean;
	/** 标记某章 dirty（查找替换全书范围用；未保存完整文本的处理见调用方） */
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

/** 剥掉章节正文首行的标题（驱动的章节文本 = 标题行 + 正文） */
function stripHeadingLine(text: string): string {
	const idx = text.indexOf("\n");
	if (idx < 0) return "";
	return text.slice(idx + 1);
}

/** 组合写回内容：标题行 + 正文，保证与下一章之间有换行分隔 */
function composeChapter(title: string, body: string): string {
	const b = body.endsWith("\n") ? body : `${body}\n`;
	return `${title}\n${b}`;
}

export const useNovelStore = create<NovelState>((set, get) => ({
	books: new Map(),
	activePath: null,

	loadBook: async (path, force = false, presetScan) => {
		try {
			const settings = loadSettings(path);
			const scan =
				presetScan ??
				(await invoke<ScanResult>("scan_chapters", {
					path,
					encodingOverride: settings.encoding || null,
					customPattern: settings.chapterRegex || null,
				}));
			if (!scan.is_novel && !(force && scan.total_bytes > 0)) return false;
			if (scan.chapters.length === 0 && scan.total_bytes > 0) {
				scan.chapters = [
					{ title: "全文", start: 0, end: scan.total_bytes, level: 2 },
				];
			}
			if (scan.chapters.length === 0) return false;
			const bookmark = loadBookmark(path);
			const book: NovelBookState = {
				path,
				scan,
				chapterIdx: bookmark?.chapterIdx ?? 0,
				chapterText: "",
				drafts: new Map(),
				editing: false,
				loading: false,
				saving: false,
				pageEnd: 0,
				paging: false,
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
			// 续读：有书签且非第一章时提示（由 UI 决定是否继续，这里先跳到记忆章）
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

	hasDirty: (path) => {
		const b = get().books.get(path);
		return !!b && (b.dirtySet.size > 0 || b.drafts.size > 0);
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
		if (scan.chapters.length === 0 && scan.total_bytes > 0) {
			scan.chapters = [{ title: "全文", start: 0, end: scan.total_bytes, level: 2 }];
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
					loading: false,
					saving: false,
					chapterText: "",
					drafts: new Map(),
					pageEnd: 0,
					paging: false,
					scrollPos: 0,
					dirtySet: new Set(),
				});
			}
			return { books };
		});
		await get().gotoChapter(path, idx);
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

		const draft = book.drafts.get(idx);
		if (draft !== undefined) {
			// 该章有未保存草稿 → 直接展示（无需磁盘加载）
			set((s) => {
				const books = new Map(s.books);
				const cur = books.get(path);
				if (cur) {
					books.set(path, {
						...cur,
						chapterIdx: idx,
						chapterText: draft,
						editing: false,
						loading: false,
						pageEnd: Math.max(0, ch.end - ch.start),
						paging: false,
						scrollPos: scrollMap.get(idx) ?? 0,
						scrollMap,
					});
				}
				return { books };
			});
			get().markReading(path, idx);
			return;
		}

		const firstEnd = Math.min(ch.end, ch.start + CHAPTER_CHUNK);
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) {
				books.set(path, {
					...cur,
					chapterIdx: idx,
					chapterText: "",
					editing: false,
					loading: true,
					pageEnd: 0,
					paging: false,
					scrollPos: scrollMap.get(idx) ?? 0,
					scrollMap,
				});
			}
			return { books };
		});
		// 邻章预取（下一章首块，提升翻页体验）
		const next = book.scan.chapters[idx + 1];
		if (next && !book.drafts.has(idx + 1)) {
			const nextEnd = Math.min(next.end, next.start + CHAPTER_CHUNK);
			void readChapterText(path, next.start, nextEnd, book.scan.encoding).catch(
				() => {},
			);
		}
		const text = await readChapterText(
			path,
			ch.start,
			firstEnd,
			book.scan.encoding,
		).catch(() => "");
		const body = stripHeadingLine(text);
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur && cur.chapterIdx === idx) {
				books.set(path, {
					...cur,
					chapterText: body,
					editing: false,
					loading: false,
					pageEnd: firstEnd - ch.start,
				});
			}
			return { books };
		});
		get().markReading(path, idx);
	},

	loadMore: async (path) => {
		const book = get().books.get(path);
		if (!book || book.loading || book.paging || book.editing || book.saving) return;
		const ch = book.scan.chapters[book.chapterIdx];
		if (!ch) return;
		// 有草稿的章节已完整，不再分页
		if (book.drafts.has(book.chapterIdx)) return;
		const startAbs = ch.start + book.pageEnd;
		if (startAbs >= ch.end) return;
		const endAbs = Math.min(ch.end, startAbs + CHAPTER_CHUNK);
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) books.set(path, { ...cur, paging: true });
			return { books };
		});
		const text = await readChapterText(
			path,
			startAbs,
			endAbs,
			book.scan.encoding,
		).catch(() => "");
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur && cur.chapterIdx === book.chapterIdx) {
				books.set(path, {
					...cur,
					chapterText: cur.chapterText + text,
					pageEnd: endAbs - ch.start,
					paging: false,
				});
			}
			return { books };
		});
	},

	ensureFullChapter: async (path) => {
		const book = get().books.get(path);
		if (!book || book.saving) return;
		if (book.drafts.has(book.chapterIdx)) return; // 草稿即全文
		const ch = book.scan.chapters[book.chapterIdx];
		if (!ch) return;
		if (book.paging) return; // loadMore 在途，避免并发双重 append（R-04）
		if (book.pageEnd >= ch.end - ch.start) return;
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) books.set(path, { ...cur, paging: true });
			return { books };
		});
		try {
			// 循环读到完整（paging 标志防止 loadMore 并发重复追加）
			for (let guard = 0; guard < 10000; guard++) {
				const b = get().books.get(path);
				const c = b?.scan.chapters[b.chapterIdx];
				if (!b || !c) break;
				if (b.pageEnd >= c.end - c.start || b.drafts.has(b.chapterIdx)) break;
				const startAbs = c.start + b.pageEnd;
				const endAbs = Math.min(c.end, startAbs + CHAPTER_CHUNK);
				const text = await readChapterText(
					path,
					startAbs,
					endAbs,
					b.scan.encoding,
				).catch(() => "");
				set((s) => {
					const books = new Map(s.books);
					const cur = books.get(path);
					if (cur && cur.chapterIdx === b.chapterIdx) {
						books.set(path, {
							...cur,
							chapterText: cur.chapterText + text,
							pageEnd: endAbs - c.start,
						});
					}
					return { books };
				});
			}
		} finally {
			set((s) => {
				const books = new Map(s.books);
				const cur = books.get(path);
				if (cur) books.set(path, { ...cur, paging: false });
				return { books };
			});
		}
	},

	setChapterText: (path, text) =>
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (!cur) return s;
			const idx = cur.chapterIdx;
			const drafts = new Map(cur.drafts);
			drafts.set(idx, text);
			const dirtySet = new Set(cur.dirtySet);
			dirtySet.add(idx);
			books.set(path, {
				...cur,
				drafts,
				chapterText: text,
				dirtySet,
			});
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
		// 编码 / 章节正则变更 → 重新扫描 + 重载（乱码/识别失败修复）
		if ("encoding" in patch || "chapterRegex" in patch) {
			void get().reapplyScan(path);
		}
	},

	reapplyScan: async (path) => {
		const book = get().books.get(path);
		if (!book) return;
		let scan: ScanResult;
		try {
			scan = await invoke<ScanResult>("scan_chapters", {
				path,
				encodingOverride: book.settings.encoding || null,
				customPattern: book.settings.chapterRegex || null,
			});
		} catch {
			return;
		}
		if (scan.chapters.length === 0 && scan.total_bytes > 0) {
			scan.chapters = [{ title: "全文", start: 0, end: scan.total_bytes, level: 2 }];
		}
		if (scan.chapters.length === 0) return;
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) {
				books.set(path, {
					...cur,
					scan,
					chapterIdx: 0,
					chapterText: "",
					drafts: new Map(),
					editing: false,
					loading: false,
					saving: false,
					pageEnd: 0,
					paging: false,
					scrollPos: 0,
					scrollMap: new Map(),
					dirtySet: new Set(),
				});
			}
			return { books };
		});
		await get().gotoChapter(path, 0);
	},

	saveChapter: async (path) => {
		const book = get().books.get(path);
		if (!book) return false;
		if (book.saving) return false;
		const savedDrafts = new Map(book.drafts);
		if (book.dirtySet.size === 0 && savedDrafts.size === 0) return true;
		// 标记保存中（拦截并发保存 + 展示态）
		set((s) => {
			const books = new Map(s.books);
			const cur = books.get(path);
			if (cur) books.set(path, { ...cur, saving: true });
			return { books };
		});
		try {
			const scan = book.scan;
			// 倒序写回：后写高索引章不改动低索引章的原始偏移
			const entries = [...savedDrafts.entries()].sort((a, b) => b[0] - a[0]);
			for (const [idx, body] of entries) {
				const ch = scan.chapters[idx];
				if (!ch) continue;
				await invoke("write_chapter", {
					path,
					start: ch.start,
					end: ch.end,
					content: composeChapter(ch.title, body),
					encoding: scan.encoding,
					hasBom: scan.has_bom,
					eol: scan.eol,
				});
			}
			// 重扫章节表（结构可能已变）
			const scan2 = await invoke<ScanResult>("scan_chapters", { path });
			// 冲突检测（R-03）：保存期间仍在编辑的章保留草稿与 dirty
			const live = get().books.get(path);
			const keep = new Map<number, string>();
			const keepDirty = new Set<number>();
			if (live) {
				for (const [idx, body] of savedDrafts) {
					const now = live.drafts.get(idx);
					if (now !== undefined && now !== body) {
						keep.set(idx, now);
						keepDirty.add(idx);
					}
				}
			}
			const curIdx = Math.min(
				live?.chapterIdx ?? 0,
				Math.max(0, scan2.chapters.length - 1),
			);
			// 当前章显示：仍在编辑的草稿优先；否则从磁盘首块加载
			const hasCurrentDraft = keep.has(curIdx);
			let chapterText = hasCurrentDraft ? keep.get(curIdx)! : "";
			let pageEnd = 0;
			if (!hasCurrentDraft) {
				const c2 = scan2.chapters[curIdx];
				if (c2) {
					const firstEnd = Math.min(c2.end, c2.start + CHAPTER_CHUNK);
					const text = await readChapterText(
						path,
						c2.start,
						firstEnd,
						scan2.encoding,
					);
					chapterText = stripHeadingLine(text);
					pageEnd = firstEnd - c2.start;
				}
			} else {
				const c2 = scan2.chapters[curIdx];
				pageEnd = c2 ? Math.max(0, c2.end - c2.start) : 0;
			}
			set((s) => {
				const books = new Map(s.books);
				const cur = books.get(path);
				if (cur) {
					books.set(path, {
						...cur,
						scan: scan2,
						chapterIdx: curIdx,
						chapterText,
						drafts: keep,
						dirtySet: keepDirty,
						editing: false,
						saving: false,
						pageEnd,
						paging: false,
					});
				}
				return { books };
			});
			return keepDirty.size === 0;
		} catch (e) {
			set((s) => {
				const books = new Map(s.books);
				const cur = books.get(path);
				if (cur) books.set(path, { ...cur, saving: false });
				return { books };
			});
			throw e;
		}
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
