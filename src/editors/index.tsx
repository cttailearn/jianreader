//! 编辑器分发：按文件类型路由到对应内核
//! - .md/.markdown：默认 MarkdownEditor（Milkdown 所见即所得），可切源码模式
//! - 其余：CodeEditor（CodeMirror 6）

import { useEffect } from "react";
import CodeEditor from "./CodeEditor";
import MarkdownEditor from "./MarkdownEditor";
import { useCursorStore } from "../stores/ui";
import { isMarkdownPath } from "../utils/mdImage";

export interface EditorHostProps {
	path: string;
	content: string;
	theme: "light" | "dark";
	status: string;
	mdView?: "wysiwyg" | "source";
	lastError?: string;
	onChange: (content: string) => void;
	onSync?: (content: string) => void;
}

export default function EditorHost(props: EditorHostProps) {
	// 切换文档时光标显示重置
	useEffect(() => {
		useCursorStore.getState().set(1, 1);
	}, [props.path]);

	if (props.status === "loading") {
		return <div className="editor-loading">⏳ 正在读取文件…</div>;
	}

	if (isMarkdownPath(props.path) && props.mdView !== "source") {
		return (
			<MarkdownEditor
				path={props.path}
				initialContent={props.content}
				onChange={props.onChange}
				onSync={props.onSync}
			/>
		);
	}
	return <CodeEditor {...props} initialContent={props.content} />;
}
