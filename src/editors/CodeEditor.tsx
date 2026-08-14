//! CodeMirror 6 封装：按需语言包 + 主题联动 + 编辑同步 + 光标上报
//! 父组件用 key={path} 保证切换标签时重建（撤销历史随标签重置，M3 再优化）

import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { getLanguage } from "../utils/language";
import { useCursorStore } from "../stores/ui";

interface Props {
	path: string;
	initialContent: string;
	theme: "light" | "dark";
	onChange: (content: string) => void;
}

const themeComp = new Compartment();
const langComp = new Compartment();

export default function CodeEditor({
	path,
	initialContent,
	theme,
	onChange,
}: Props) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	// 创建编辑器视图（仅一次，随 key 重建）
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const state = EditorState.create({
			doc: initialContent,
			extensions: [
				basicSetup,
				themeComp.of(theme === "dark" ? oneDark : []),
				langComp.of([]),
				EditorView.updateListener.of((u) => {
					if (u.docChanged) onChangeRef.current(u.state.doc.toString());
					if (u.docChanged || u.selectionSet) {
						const head = u.state.selection.main.head;
						const line = u.state.doc.lineAt(head);
						useCursorStore.getState().set(line.number, head - line.from + 1);
					}
				}),
			],
		});
		const view = new EditorView({ state, parent: host });
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// 仅在挂载时创建（内容同步走 store + onChange）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 主题联动
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: themeComp.reconfigure(theme === "dark" ? oneDark : []),
		});
	}, [theme]);

	// 语言包按需加载
	useEffect(() => {
		let cancelled = false;
		const lang = getLanguage(path);
		if (!lang) {
			viewRef.current?.dispatch({ effects: langComp.reconfigure([]) });
			return;
		}
		lang
			.load()
			.then((sup) => {
				if (!cancelled) {
					viewRef.current?.dispatch({
						effects: langComp.reconfigure(sup),
					});
				}
			})
			.catch(() => {
				/* 语言包加载失败则保持纯文本 */
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	return <div className="code-editor-host" ref={hostRef} />;
}
