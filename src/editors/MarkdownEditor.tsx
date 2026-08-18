//! Markdown 所见即所得编辑器（Milkdown Crepe）
//! - GFM（表格/任务列表/代码块嵌入 CM6 编辑）+ LaTeX + 图片块 + 工具栏
//! - 主题联动：浅色用 nord.css，浅色代码块显式 light 主题（Crepe 默认 oneDark 会看不清）
//! - 本地相对路径图片：加载转 asset URL，onChange 回传前还原相对路径
//! - 大纲：包装 view.dispatch，doc 变更后 120ms 防抖刷新（不依赖 listener debounce）
//! - M12：当前文件内查找/替换（逐文本节点匹配，selection 高亮 = 替换前确认）

import { useCallback, useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
// 组件样式（表格/标题/列表/代码块等全部组件）：主题 css 只含颜色变量，组件样式必须另引
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/nord.css";
import "@milkdown/crepe/theme/frame.css";
import "katex/dist/katex.min.css";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import {
	Decoration,
	DecorationSet,
	type EditorView as PMEditorView,
} from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import {
	dirnameOf,
	normalizeTables,
	resolveMarkdownImages,
	unresolveMarkdownImages,
} from "../utils/mdImage";
import { buildToc, useMdStore } from "../stores/md";

interface FindMatch {
	from: number;
	to: number;
}

/** 在 doc 内逐文本节点查找（不跨块），返回 PM doc 位置 */
function findInDoc(doc: PMNode, query: string): FindMatch[] {
	const out: FindMatch[] = [];
	const lower = query.toLowerCase();
	doc.descendants((node, pos) => {
		if (!node.isText) return;
		const text = node.text ?? "";
		const t = text.toLowerCase();
		let i = t.indexOf(lower);
		while (i >= 0) {
			out.push({ from: pos + i, to: pos + i + query.length });
			i = t.indexOf(lower, i + Math.max(1, query.length));
		}
	});
	return out;
}

interface Props {
	path: string;
	initialContent: string;
	/** 浅/暗色（联动代码块内嵌 CM6 主题，M11） */
	theme: "light" | "dark";
	onChange: (markdown: string) => void;
	/** 静默同步（解析规范化，不标 dirty） */
	onSync?: (markdown: string) => void;
	/** 只读（磁盘属性/大文件保护） */
	readonly?: boolean;
}

export default function MarkdownEditor({
	path,
	initialContent,
	theme,
	onChange,
	onSync,
	readonly = false,
}: Props) {
	const hostRef = useRef<HTMLDivElement>(null);
	const ctxRef = useRef<Ctx | null>(null);
	const viewRef = useRef<PMEditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSyncRef = useRef(onSync);
	onSyncRef.current = onSync;

	// M12：查找/替换状态（当前文件内；替换前先定位选中 = 确认）
	const [findOpen, setFindOpen] = useState(false);
	const [findText, setFindText] = useState("");
	const [replaceText, setReplaceText] = useState("");
	const [matches, setMatches] = useState<FindMatch[]>([]);
	const [findIdx, setFindIdx] = useState(0);
	const findInputRef = useRef<HTMLInputElement>(null);
	// M12：全量匹配高亮 —— Decoration 插件从该 ref 读取（避免 React 状态变化重建插件）
	const findRef = useRef<{ matches: FindMatch[]; idx: number; query: string }>({
		matches: [],
		idx: 0,
		query: "",
	});

	// M12：定位并选中某处匹配（PM TextSelection → dispatch → 滚动）
	const selectMatch = useCallback((m: FindMatch) => {
		const view = viewRef.current;
		if (!view) return;
		if (m.to > view.state.doc.content.size) return;
		try {
			view.dispatch(
				view.state.tr
					.setSelection(TextSelection.create(view.state.doc, m.from, m.to))
					.scrollIntoView(),
			);
		} catch {
			/* 边界情况忽略 */
		}
	}, []);

	// M12：清空查找状态（含全量匹配 Decoration 高亮）
	const clearFind = useCallback(() => {
		findRef.current = { matches: [], idx: 0, query: "" };
		setMatches([]);
		setFindIdx(0);
		const view = viewRef.current;
		// no-op 事务触发插件 apply，清除高亮
		if (view) view.dispatch(view.state.tr);
	}, []);

	// M12：执行查找，刷新匹配列表并定位（从当前光标之后的下一个开始）
	const doFind = useCallback(
		(query: string) => {
			const view = viewRef.current;
			if (!view) return;
			const next = findInDoc(view.state.doc, query);
			if (next.length === 0) {
				clearFind();
				return;
			}
			const cur = view.state.selection.from;
			let i = next.findIndex((m) => m.from >= cur - 1);
			if (i < 0) i = 0;
			findRef.current = { matches: next, idx: i, query };
			setMatches(next);
			setFindIdx(i);
			// 选中事务触发插件 apply，刷新全量匹配高亮
			selectMatch(next[i]);
		},
		[selectMatch, clearFind],
	);

	// M12：跳转到下一个/上一个匹配（Enter / Shift+Enter）
	const stepFind = useCallback(
		(dir: 1 | -1) => {
			if (matches.length === 0) return;
			const i = (findIdx + dir + matches.length) % matches.length;
			findRef.current = { matches, idx: i, query: findText };
			setFindIdx(i);
			selectMatch(matches[i]);
		},
		[matches, findIdx, findText, selectMatch],
	);

	// M12：替换当前匹配（selection 已选中 = 用户已看到定位内容，即确认）
	const replaceCurrent = useCallback(() => {
		const view = viewRef.current;
		if (!view) return;
		const m = matches[findIdx];
		if (!m) return;
		if (m.to > view.state.doc.content.size) return;
		try {
			view.dispatch(
				view.state.tr.replaceWith(
					m.from,
					m.to,
					view.state.schema.text(replaceText),
				),
			);
			// 替换后重新查找，定位下一个匹配（原位置后的第一个）
			doFind(findText);
		} catch {
			/* ignore */
		}
	}, [matches, findIdx, replaceText, doFind, findText]);

	// M12：全部替换（从后往前避免偏移错乱）
	const replaceAll = useCallback(() => {
		const view = viewRef.current;
		if (!view || matches.length === 0) return;
		try {
			const tr = view.state.tr;
			for (let i = matches.length - 1; i >= 0; i--) {
				const m = matches[i];
				tr.replaceWith(m.from, m.to, view.state.schema.text(replaceText));
			}
			view.dispatch(tr);
			setMatches([]);
			setFindIdx(0);
			// 内容变化后由 markdownUpdated 回传；这里重新查找以刷新计数
			doFind(findText);
		} catch {
			/* ignore */
		}
	}, [matches, replaceText, doFind, findText]);

	// M12：Ctrl+F 打开查找面板（MD 编辑区自身；代码块 CM6/输入框不拦截，避免冲突）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
				const t = e.target as HTMLElement | null;
				if (
					t?.closest(".cm-editor") ||
					t?.closest("input") ||
					t?.closest("textarea")
				) {
					return;
				}
				e.preventDefault();
				setFindOpen(true);
				setTimeout(() => findInputRef.current?.select(), 30);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// M12：Ctrl+F 打开查找（仅 MD 预览模式自身；源码模式由 CM6 searchKeymap 处理）
	useEffect(() => {
		if (!findOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				clearFind();
				setFindOpen(false);
				viewRef.current?.focus();
			} else if (e.key === "Enter") {
				e.preventDefault();
				stepFind(e.shiftKey ? -1 : 1);
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
				e.preventDefault();
				findInputRef.current?.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [findOpen, stepFind, clearFind]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const dir = dirnameOf(path);
		const md = useMdStore.getState();
		// 实例存活标记：旧实例的所有回调必须失效（StrictMode/重建竞态防护）
		let active = true;

		// 代码块内嵌 CM6 主题跟随应用主题。注意：Crepe 默认配置就是 oneDark（dark），
		// featureConfigs 是深合并，浅色时若不显式覆盖会保留 oneDark → 浅灰文字看不清（M11 bug）
		const cmTheme = (() => {
			if (theme === "dark") return oneDark;
			// 浅色：显式 light 主题（dark:false 让高亮走 light 配色），深色正文保证对比度
			return EditorView.theme(
				{
					".cm-content": { color: "#1f2328" },
					".cm-gutters": { color: "#646a73" },
					".cm-activeLineGutter": { backgroundColor: "transparent" },
				},
				{ dark: false },
			);
		})();

		const crepe = new Crepe({
			root: host,
			// 渲染前规范化：无表头分隔行的管道表格自动补分隔行（否则 GFM 不渲染）
			defaultValue: normalizeTables(resolveMarkdownImages(initialContent, dir)),
			features: {
				[Crepe.Feature.CodeMirror]: true, // 代码块内嵌 CM6（高亮+编辑）
				[Crepe.Feature.ListItem]: true,
				[Crepe.Feature.LinkTooltip]: true,
				[Crepe.Feature.Cursor]: true,
				[Crepe.Feature.ImageBlock]: true,
				[Crepe.Feature.BlockEdit]: true,
				[Crepe.Feature.Toolbar]: true,
				[Crepe.Feature.Placeholder]: true,
				[Crepe.Feature.Table]: true,
				[Crepe.Feature.Latex]: true,
			},
			// 代码块内嵌 CM6 主题跟随应用主题（浅色必须显式覆盖 Crepe 默认 oneDark）
			featureConfigs: {
				[Crepe.Feature.CodeMirror]: { theme: cmTheme },
			},
		});
		if (readonly) crepe.setReadonly(true);

		// M12：全量匹配高亮（Decoration）：所有匹配浅色、当前匹配深色（当前处另有选区标记）
		const findKey = new PluginKey<DecorationSet>("mdFindHighlight");
		const findPlugin = new Plugin({
			key: findKey,
			state: {
				init: () => DecorationSet.empty,
				apply: (tr) => {
					const { matches, idx, query } = findRef.current;
					if (matches.length === 0) return DecorationSet.empty;
					const decos: Decoration[] = [];
					for (let i = 0; i < matches.length; i++) {
						const m = matches[i];
						// 编辑后位置失效：越界或文本已变则跳过，不高亮错误内容
						if (m.to > tr.doc.content.size) continue;
						if (tr.doc.textBetween(m.from, m.to).toLowerCase() !== query) continue;
						decos.push(
							Decoration.inline(m.from, m.to, {
								class: i === idx ? "md-find-active" : "md-find-match",
							}),
						);
					}
					return DecorationSet.create(tr.doc, decos);
				},
			},
			props: {
				decorations: (state) => findKey.getState(state) ?? DecorationSet.empty,
			},
		});
		crepe.editor.use($prose(() => findPlugin));

		// 大纲刷新：读 ctx.get(editorViewCtx) 当前视图（Crepe 初始化期间会替换 view，
		// mounted 时捕获的旧引用会读到未完成解析的 doc——实测旧引用 doc 只有 5 个标题）
		const refreshToc = () => {
			if (!active) return;
			const ctx = ctxRef.current;
			if (!ctx) return;
			let view: { state: { doc: unknown } } | null = null;
			try {
				view = ctx.get(editorViewCtx) as unknown as {
					state: { doc: unknown };
				};
			} catch {
				view = viewRef.current;
			}
			if (!view) return;
			md.setToc(
				buildToc(view.state.doc as unknown as Parameters<typeof buildToc>[0]),
			);
		};

		// 滚动跟随（scrollspy）：高亮视口顶部最近的标题
		const onHostScroll = () => {
			const ctx = ctxRef.current;
			if (!ctx) return;
			const headings = Array.from(
				host.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
			);
			const threshold = host.scrollTop + 80;
			let currentHeading: HTMLElement | null = null;
			for (const h of headings) {
				if (h.offsetTop <= threshold) currentHeading = h;
				else break;
			}
			if (currentHeading) {
				// 由 DOM 位置反查 doc pos
				const view = ctx.get(editorViewCtx);
				const domPos = view.posAtDOM(currentHeading, 0);
				md.setActive(domPos);
			} else {
				md.setActive(null);
			}
		};

		crepe.on((api) => {
			// 内容变更 → 回传 markdown（还原相对路径）
			// 首次变更视为 Crepe 解析规范化（如 GFM 任务列表 - → *），静默同步不标 dirty；
			// 之后的变更才是用户编辑 → 标 dirty
			let firstMarkdownEvent = true;
			api.markdownUpdated((_ctx, markdown) => {
				if (!active) return;
				// 解析完成后 doc 已完整，此时刷新大纲最可靠（initial parse 完成后也会触发）
				refreshToc();
				const mdOut = unresolveMarkdownImages(markdown, dir);
				if (firstMarkdownEvent) {
					firstMarkdownEvent = false;
					if (mdOut !== initialContent) {
						onSyncRef.current?.(mdOut);
					}
					return;
				}
				if (mdOut !== initialContent) {
					onChangeRef.current(mdOut);
				}
			});

			// 挂载后：注入桥接 api + 包装 dispatch（同步大纲刷新）+ 首次大纲
			api.mounted((ctx) => {
				if (!active) return;
				ctxRef.current = ctx;
				const view = ctx.get(editorViewCtx);
				viewRef.current = view;

				// 包装 dispatch：doc 变更后同步刷新大纲（PM dispatch 同步更新 state，
				// 定时器/ctx.get 在 Crepe 多实例环境下不可靠）
				const origDispatch = view.dispatch.bind(view);
				view.dispatch = (tr: unknown) => {
					const docChanged = (tr as { docChanged?: boolean }).docChanged === true;
					origDispatch(tr as never);
					if (docChanged) refreshToc();
				};

				md.setApi({
					jump: (pos) => {
						const v = ctx.get(editorViewCtx);
						v.dispatch(
							v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos))),
						);
						// 用 nodeDOM 直接拿该位置的节点元素（domAtPos 在边界会返回父容器+偏移）
						const nodeDom = v.nodeDOM(pos);
						let el: Element | null = null;
						if (nodeDom instanceof Element) {
							el = nodeDom;
						} else if (nodeDom?.parentElement) {
							el = nodeDom.parentElement;
						}
						const heading = el?.closest?.("h1, h2, h3, h4, h5, h6");
						(heading ?? el)?.scrollIntoView({ block: "start" });
					},
					getScrollElement: () => host,
					refreshToc,
					getView: () => ctx.get(editorViewCtx),
				});
				md.setToc(
					buildToc(view.state.doc as unknown as Parameters<typeof buildToc>[0]),
				);
				// Crepe 初始解析可能晚于 mounted 完成（首次构建时深层标题未就位），
				// 延迟补刷两次兜底（解析 <1MB 文档远快于 600ms）
				setTimeout(() => {
					if (active) refreshToc();
				}, 120);
				setTimeout(() => {
					if (active) refreshToc();
				}, 600);
				host.addEventListener("scroll", onHostScroll, { passive: true });
			});

			api.destroy(() => {
				if (!active) return;
				md.setApi(null);
				md.setToc([]);
				md.setActive(null);
			});
		});

		void crepe.create().then(() => {
			if (!active) void crepe.destroy();
		});

		return () => {
			active = false;
			host.removeEventListener("scroll", onHostScroll);
			md.setApi(null);
			md.setToc([]);
			md.setActive(null);
			void crepe.destroy();
		};
		// 仅在挂载时装配（切换标签由父级 key 重建）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="markdown-wrap">
			{findOpen && (
				<div className="md-find-bar">
					<input
						ref={findInputRef}
						className="md-find-input"
						placeholder="查找"
						value={findText}
						onChange={(e) => {
							setFindText(e.target.value);
							doFind(e.target.value);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								stepFind(e.shiftKey ? -1 : 1);
							}
						}}
					/>
					<span className="md-find-count">
						{matches.length > 0 ? `${findIdx + 1}/${matches.length}` : "0/0"}
					</span>
					<button
						className="md-find-btn"
						onClick={() => stepFind(-1)}
						title="上一个 (Shift+Enter)"
						disabled={matches.length === 0}
					>
						▲
					</button>
					<button
						className="md-find-btn"
						onClick={() => stepFind(1)}
						title="下一个 (Enter)"
						disabled={matches.length === 0}
					>
						▼
					</button>
					{!readonly && (
						<>
							<span className="md-find-sep" />
							<input
								className="md-find-input md-find-replace"
								placeholder="替换为"
								value={replaceText}
								onChange={(e) => setReplaceText(e.target.value)}
							/>
							<button
								className="md-find-btn"
								onClick={() => replaceCurrent()}
								disabled={matches.length === 0}
								title="替换当前（已定位选中，确认后执行）"
							>
								替换
							</button>
							<button
								className="md-find-btn"
								onClick={() => replaceAll()}
								disabled={matches.length === 0}
								title="全部替换"
							>
								全部
							</button>
						</>
					)}
					<button
						className="md-find-btn"
						onClick={() => {
							clearFind();
							setFindOpen(false);
						}}
						title="关闭 (Esc)"
					>
						✕
					</button>
				</div>
			)}
			<div className="markdown-host" ref={hostRef} />
		</div>
	);
}
