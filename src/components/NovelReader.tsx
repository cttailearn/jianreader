//! 小说阅读视图：章节渲染 + 阅读设置 + 章内直接编辑 + 查找替换 + 续读
//!
//! - 阅读背景/字体独立于 app 主题（米黄护眼默认）
//! - 点击正文 → 当前章进入编辑态（contenteditable 纯文本，光标选区保留）
//! - Ctrl+S 按章节 offset 写回（Rust write_chapter），保存后重解析章节表
//! - Ctrl+F 章内搜索（高亮+计数），可展开全书
//! - 切章记忆滚动位置；重开书籍直达上次位置（loadBook 已恢复）

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ENCODING_OPTIONS,
	useNovelStore,
	type ReadingSettings,
} from "../stores/novel";
import { saveActiveNovel } from "../stores/saveNovel";
import { useTabsStore } from "../stores/tabs";

interface Props {
	path: string;
}

export default function NovelReader({ path }: Props) {
	const book = useNovelStore((s) => s.books.get(path));
	const gotoChapter = useNovelStore((s) => s.gotoChapter);
	const setChapterText = useNovelStore((s) => s.setChapterText);
	const setEditing = useNovelStore((s) => s.setEditing);
	const updateSettings = useNovelStore((s) => s.updateSettings);
	// 标签只读状态（磁盘只读属性 → 禁编辑/禁保存）
	const tabReadonly = useTabsStore(
		(s) => s.tabs.find((t) => t.path === path)?.readonly ?? false,
	);

	const scrollRef = useRef<HTMLDivElement>(null);
	const textRef = useRef<HTMLDivElement | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	const [findOpen, setFindOpen] = useState(false);
	const [findText, setFindText] = useState("");
	const [replaceText, setReplaceText] = useState("");
	const [findScope, setFindScope] = useState<"chapter" | "book">("chapter");
	const [findIdx, setFindIdx] = useState(0);
	// 全书搜索结果 { chapterIdx, text, matches }
	const [bookResults, setBookResults] = useState<
		{ chapterIdx: number; matches: number }[]
	>([]);

	// 滚动容器 data 标记
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		el.setAttribute("data-novel-scroll", path);
	}, [path]);

	// 切章后恢复该章滚动位置 + 退出编辑态
	useEffect(() => {
		const el = scrollRef.current;
		if (el && book) el.scrollTop = book.scrollPos;
		if (book?.editing && textRef.current) {
			textRef.current.focus();
		}
	}, [book?.chapterIdx, book?.loading]); // eslint-disable-line react-hooks/exhaustive-deps

	// 滚动位置实时记录（防抖写 store）+ 接近底部自动加载下一页（大章分页）
	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		useNovelStore.getState().setScrollPos(path, el.scrollTop);
		// 距底 < 2400px 且未加载完 → 加载下一块
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 2400) {
			void useNovelStore.getState().loadMore(path);
		}
	}, [path]);

	// dirty 集合同步到标签状态（圆点/关闭确认）
	useEffect(() => {
		useTabsStore.getState().setNovelDirty(path, (book?.dirtySet.size ?? 0) > 0);
	}, [book?.dirtySet]);

	if (!book) return null;
	const ch = book.scan.chapters[book.chapterIdx];
	const s = book.settings;
	/** 当前章是否已完整加载（分页未完成） */
	const chapterLoaded = ch ? book.pageEnd >= ch.end - ch.start : true;

	/** 点击正文进入编辑态：大章先完整加载再编辑 */
	const enterEdit = () => {
		if (tabReadonly) return;
		if (!chapterLoaded) {
			void (async () => {
				await useNovelStore.getState().ensureFullChapter(path);
				useNovelStore.getState().setEditing(path, true);
			})();
			return;
		}
		setEditing(path, true);
	};
	const styleVars = {
		"--novel-font-size": `${s.fontSize}px`,
		"--novel-line-height": String(s.lineHeight),
		"--novel-letter-spacing": `${s.letterSpacing}em`,
		"--novel-para-spacing": `${s.paraSpacing}em`,
		"--novel-width": `${s.contentWidth}ch`,
	} as React.CSSProperties;

	/** 编辑态输入 → store（标 dirty） */
	const onInput = () => {
		const el = textRef.current;
		if (!el) return;
		// contenteditable 的 innerText 保留换行
		const text = el.innerText.replace(/\u00a0/g, " ");
		setChapterText(path, text);
	};

	const save = async () => {
		await saveActiveNovel(path);
	};

	// Ctrl+F 打开查找栏
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
				e.preventDefault();
				setFindOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// ---- 章内查找（虚拟高亮：匹配段落重新渲染）----
	const findMatches = useMemo(() => {
		if (!findText || !book) return [];
		const text = book.chapterText;
		const out: number[] = [];
		let idx = text.indexOf(findText);
		while (idx >= 0) {
			out.push(idx);
			idx = text.indexOf(findText, idx + Math.max(1, findText.length));
		}
		return out;
	}, [findText, book?.chapterText]);

	/** 展开全书：逐章扫描（懒加载章节文本） */
	const searchBook = async () => {
		const text = findText;
		if (!text || !book) return;
		const results: { chapterIdx: number; matches: number }[] = [];
		for (let i = 0; i < book.scan.chapters.length; i++) {
			const c = book.scan.chapters[i];
			let body: string;
			if (i === book.chapterIdx) {
				body = book.chapterText;
			} else {
				const { invoke } = await import("@tauri-apps/api/core");
				body = await invoke<string>("read_chapter", {
					path,
					start: c.start,
					end: c.end,
					encoding: book.scan.encoding,
				}).catch(() => "");
			}
			let n = 0;
			let idx = body.indexOf(text);
			while (idx >= 0) {
				n++;
				idx = body.indexOf(text, idx + Math.max(1, text.length));
			}
			if (n > 0) results.push({ chapterIdx: i, matches: n });
		}
		setBookResults(results);
	};

	/** 替换当前高亮匹配（本章） */
	const replaceCurrent = () => {
		if (!findText || findMatches.length === 0 || !book) return;
		const i = findIdx % findMatches.length;
		const at = findMatches[i];
		const next =
			book.chapterText.slice(0, at) +
			replaceText +
			book.chapterText.slice(at + findText.length);
		setChapterText(path, next);
		setEditing(path, false); // contenteditable 是原生 DOM，替换后退出编辑态重渲染
	};

	/** 全部替换（本章） */
	const replaceAll = () => {
		if (!findText || findMatches.length === 0 || !book) return;
		const next = book.chapterText.split(findText).join(replaceText);
		setChapterText(path, next);
		setEditing(path, false);
	};
	const paragraphs = useMemo(() => {
		const text = book?.chapterText ?? "";
		return text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	}, [book?.chapterText]);

	return (
		<div className="novel-reader" style={styleVars}>
			<div className="novel-toolbar">
				<button
					className="novel-btn"
					disabled={book.chapterIdx === 0}
					onClick={() => void gotoChapter(path, book.chapterIdx - 1)}
					title="上一章"
				>
					← 上一章
				</button>
				<span className="novel-chapter-title">
					{ch?.title ?? ""}
					{tabReadonly && (
						<span className="novel-lock" title="文件为只读（磁盘只读属性）">
							🔒
						</span>
					)}
					{book.dirtySet.has(book.chapterIdx) && (
						<span className="novel-dirty-dot" title="本章已修改" />
					)}
				</span>
				<button
					className="novel-btn"
					disabled={book.chapterIdx >= book.scan.chapters.length - 1}
					onClick={() => void gotoChapter(path, book.chapterIdx + 1)}
					title="下一章"
				>
					下一章 →
				</button>
				<span className="novel-toolbar-spacer" />
				<button
					className="novel-btn"
					onClick={() => setFindOpen((v) => !v)}
					title="查找替换 (Ctrl+F)"
				>
					🔍
				</button>
				<button
					className="novel-btn"
					onClick={() => setShowSettings((v) => !v)}
					title="阅读设置"
				>
					⚙️ 阅读设置
				</button>
				{book.editing ? (
					<button
						className="novel-btn"
						onClick={() => setEditing(path, false)}
						title="完成编辑"
					>
						✅ 完成
					</button>
				) : (
					<button
						className="novel-btn"
						onClick={enterEdit}
						disabled={tabReadonly}
						title={tabReadonly ? "只读文件不可编辑" : "编辑本章（也可点击正文进入）"}
					>
						✏️ 编辑本章
					</button>
				)}
				<button
					className="novel-btn novel-btn-primary"
					disabled={tabReadonly || !book.dirtySet.has(book.chapterIdx)}
					onClick={() => void save()}
					title={tabReadonly ? "只读文件无法保存" : "保存本章 (Ctrl+S)"}
				>
					💾 保存
				</button>
			</div>

			{findOpen && (
				<div className="novel-find-bar">
					<input
						className="novel-find-input"
						placeholder="查找…"
						value={findText}
						onChange={(e) => {
							setFindText(e.target.value);
							setFindIdx(0);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								setFindIdx((i) => (i + 1) % Math.max(1, findMatches.length));
							}
						}}
						autoFocus
					/>
					<span className="novel-find-count">
						{findText
							? `${findMatches.length} 处匹配${
									findMatches.length > 0 ? `（第 ${findIdx + 1} 处）` : ""
								}`
							: ""}
					</span>
					{findScope === "chapter" && (
						<>
							<input
								className="novel-find-input novel-find-replace"
								placeholder="替换为…"
								value={replaceText}
								onChange={(e) => setReplaceText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") replaceCurrent();
								}}
							/>
							<button
								className="novel-btn"
								onClick={replaceCurrent}
								disabled={findMatches.length === 0}
								title="替换当前匹配 (Enter)"
							>
								替换
							</button>
							<button
								className="novel-btn"
								onClick={replaceAll}
								disabled={findMatches.length === 0}
								title="替换本章全部匹配"
							>
								全部替换
							</button>
						</>
					)}
					<select
						className="novel-find-scope"
						value={findScope}
						onChange={(e) => {
							setFindScope(e.target.value as "chapter" | "book");
							if (e.target.value === "book") void searchBook();
						}}
					>
						<option value="chapter">本章</option>
						<option value="book">全书</option>
					</select>
					{findScope === "book" && (
						<div className="novel-find-book-results">
							{bookResults.length === 0 && findText && <span>全书无匹配</span>}
							{bookResults.slice(0, 50).map((r) => (
								<button
									key={r.chapterIdx}
									className="novel-find-result"
									onClick={() => void gotoChapter(path, r.chapterIdx)}
								>
									{book.scan.chapters[r.chapterIdx].title}（{r.matches} 处）
								</button>
							))}
						</div>
					)}
				</div>
			)}

			{showSettings && (
				<SettingsPanel
					settings={s}
					onChange={(patch) => updateSettings(path, patch)}
				/>
			)}

			<div
				className={`novel-scroll novel-bg-${s.bg}`}
				ref={scrollRef}
				onScroll={onScroll}
				data-novel-scroll={path}
			>
				{book.loading ? (
					<div className="editor-loading">⏳ 正在加载章节…</div>
				) : book.editing ? (
					<div
						className="novel-text novel-editing"
						contentEditable
						suppressContentEditableWarning
						onInput={onInput}
						onBlur={() => {
							setEditing(path, false);
						}}
						// 挂载时按行注入原文（contenteditable 内 \n 不产生换行，逐行建 <div> 块；
						// innerText 读回时每 <div> = 一行，与原文结构一致，空行保留）
						ref={(el) => {
							textRef.current = el;
							if (el && !el.dataset.seeded && book) {
								el.dataset.seeded = "1";
								for (const line of book.chapterText.split(/\r?\n/)) {
									const d = document.createElement("div");
									d.textContent = line;
									el.appendChild(d);
								}
							}
						}}
					/>
				) : (
					<div
						className="novel-text"
						onClick={enterEdit}
						title={tabReadonly ? "文件为只读" : "点击编辑本章"}
					>
						{paragraphs.map((p, i) => {
							const hl =
								findText && findMatches.length > 0
									? highlightText(p, findText, findIdx, findMatches)
									: null;
							return hl ? <p key={i}>{hl}</p> : <p key={i}>{p}</p>;
						})}
					</div>
				)}
				<div className="novel-end">
					{book.paging && <span className="novel-paging">加载中…</span>}
					{book.chapterIdx < book.scan.chapters.length - 1 ? (
						<button
							className="novel-btn"
							onClick={() => void gotoChapter(path, book.chapterIdx + 1)}
						>
							下一章 →
						</button>
					) : (
						<span>— 全书完 —</span>
					)}
				</div>
			</div>
		</div>
	);
}

/** 章内查找高亮（虚拟 DOM 渲染，不污染 contenteditable） */
function highlightText(
	text: string,
	findText: string,
	activeIdx: number,
	matches: number[],
): React.ReactNode[] {
	// matches 是全局偏移，这里按段落内出现次数逐个高亮
	const parts: React.ReactNode[] = [];
	let rest = text;
	let local = 0;
	let globalBase = 0;
	let found = 0;
	while (rest.length > 0) {
		const i = rest.indexOf(findText);
		if (i < 0) {
			parts.push(rest);
			break;
		}
		parts.push(rest.slice(0, i));
		const isActive = found === activeIdx % Math.max(1, matches.length);
		parts.push(
			<mark key={globalBase + i} className={isActive ? "find-active" : ""}>
				{rest.slice(i, i + findText.length)}
			</mark>,
		);
		rest = rest.slice(i + findText.length);
		globalBase += i + findText.length;
		found++;
		local++;
	}
	void local;
	return parts;
}

/** 阅读设置弹出面板 */
function SettingsPanel({
	settings,
	onChange,
}: {
	settings: ReadingSettings;
	onChange: (patch: Partial<ReadingSettings>) => void;
}) {
	const bgOptions: { id: ReadingSettings["bg"]; label: string }[] = [
		{ id: "sepia", label: "米黄护眼" },
		{ id: "light", label: "浅色" },
		{ id: "gray", label: "浅灰" },
		{ id: "dark", label: "夜间纯黑" },
	];
	const [regexDraft, setRegexDraft] = useState(settings.chapterRegex ?? "");
	return (
		<div className="novel-settings">
			<div className="novel-settings-row">
				<label>字号 {settings.fontSize}px</label>
				<input
					type="range"
					min={14}
					max={36}
					value={settings.fontSize}
					onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
				/>
			</div>
			<div className="novel-settings-row">
				<label>行距 {settings.lineHeight.toFixed(1)}</label>
				<input
					type="range"
					min={1.5}
					max={2.5}
					step={0.1}
					value={settings.lineHeight}
					onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
				/>
			</div>
			<div className="novel-settings-row">
				<label>字间距 {Math.round(settings.letterSpacing * 100)}%</label>
				<input
					type="range"
					min={0}
					max={0.3}
					step={0.01}
					value={settings.letterSpacing}
					onChange={(e) => onChange({ letterSpacing: Number(e.target.value) })}
				/>
			</div>
			<div className="novel-settings-row">
				<label>段间距 {settings.paraSpacing.toFixed(1)}em</label>
				<input
					type="range"
					min={0}
					max={2}
					step={0.1}
					value={settings.paraSpacing}
					onChange={(e) => onChange({ paraSpacing: Number(e.target.value) })}
				/>
			</div>
			<div className="novel-settings-row">
				<label>正文宽度 {settings.contentWidth}ch</label>
				<input
					type="range"
					min={60}
					max={80}
					value={settings.contentWidth}
					onChange={(e) => onChange({ contentWidth: Number(e.target.value) })}
				/>
			</div>
			<div className="novel-settings-row novel-settings-bg">
				<label>背景</label>
				<div className="novel-bg-options">
					{bgOptions.map((o) => (
						<button
							key={o.id}
							className={"novel-bg-opt" + (settings.bg === o.id ? " active" : "")}
							onClick={() => onChange({ bg: o.id })}
						>
							<span className={`novel-bg-swatch novel-bg-${o.id}`} />
							{o.label}
						</button>
					))}
				</div>
			</div>
			{/* 文件编码（乱码时切换，自动重扫重载） */}
			<div className="novel-settings-row novel-settings-encoding">
				<label>文件编码</label>
				<select
					className="novel-settings-select"
					value={settings.encoding ?? ""}
					onChange={(e) => {
						const v = e.target.value;
						onChange({ encoding: v === "" ? undefined : v });
					}}
					title="乱码时切换编码，自动重新扫描章节并重载"
				>
					{ENCODING_OPTIONS.map((opt) => (
						<option key={opt} value={opt === "自动检测" ? "" : opt}>
							{opt}
						</option>
					))}
				</select>
			</div>
			{/* 自定义章节识别正则（空 = 内置规则） */}
			<div className="novel-settings-row novel-settings-regex">
				<label>章节正则</label>
				<input
					className="novel-settings-input"
					placeholder="如：^【.+】 或 ^第.+[章回]"
					value={regexDraft}
					onChange={(e) => setRegexDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							onChange({ chapterRegex: regexDraft.trim() || undefined });
						}
					}}
					title="正则匹配的行视为章节标题（作用于行首去空白后的行），回车应用并重新扫描"
				/>
				<button
					className="novel-btn"
					onClick={() => onChange({ chapterRegex: regexDraft.trim() || undefined })}
				>
					应用
				</button>
			</div>
			<button
				className="novel-btn"
				onClick={() => {
					setRegexDraft("");
					onChange({
						fontSize: 19,
						lineHeight: 2.0,
						letterSpacing: 0.02,
						paraSpacing: 0.8,
						contentWidth: 70,
						bg: "sepia",
						encoding: undefined,
						chapterRegex: undefined,
					});
				}}
			>
				恢复默认
			</button>
		</div>
	);
}
