//! Markdown 所见即所得编辑器（Milkdown Crepe）
//! - GFM（表格/任务列表/代码块嵌入 CM6 编辑）+ LaTeX + 图片块 + 工具栏
//! - 主题联动：浅色用 nord.css，暗色用 tokens.css 里的 --crepe-* 变量覆盖
//! - 本地相对路径图片：加载转 asset URL，onChange 回传前还原相对路径
//! - 大纲：包装 view.dispatch，doc 变更后 120ms 防抖刷新（不依赖 listener debounce）

import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
// 组件样式（表格/标题/列表/代码块等全部组件）：主题 css 只含颜色变量，组件样式必须另引
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/nord.css";
import "@milkdown/crepe/theme/frame.css";
import "katex/dist/katex.min.css";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { TextSelection } from "@milkdown/prose/state";
import {
	dirnameOf,
	resolveMarkdownImages,
	unresolveMarkdownImages,
} from "../utils/mdImage";
import { buildToc, useMdStore } from "../stores/md";

interface Props {
	path: string;
	initialContent: string;
	onChange: (markdown: string) => void;
	/** 静默同步（解析规范化，不标 dirty） */
	onSync?: (markdown: string) => void;
	/** 只读（磁盘属性/大文件保护） */
	readonly?: boolean;
}

export default function MarkdownEditor({
	path,
	initialContent,
	onChange,
	onSync,
	readonly = false,
}: Props) {
	const hostRef = useRef<HTMLDivElement>(null);
	const ctxRef = useRef<Ctx | null>(null);
	const viewRef = useRef<{ state: { doc: unknown } } | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSyncRef = useRef(onSync);
	onSyncRef.current = onSync;

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const dir = dirnameOf(path);
		const md = useMdStore.getState();
		// 实例存活标记：旧实例的所有回调必须失效（StrictMode/重建竞态防护）
		let active = true;

		const crepe = new Crepe({
			root: host,
			defaultValue: resolveMarkdownImages(initialContent, dir),
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
		});
		if (readonly) crepe.setReadonly(true);

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
				viewRef.current = view as unknown as typeof viewRef.current;

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

	return <div className="markdown-host" ref={hostRef} />;
}
