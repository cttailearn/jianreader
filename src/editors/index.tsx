//! 编辑器分发：按文件类型路由到对应内核
//! M2：全部走 CodeMirror（MD 也先用 markdown 语言包）
//! M4：.md/.markdown 切到 Milkdown 所见即所得

import { useEffect } from "react";
import CodeEditor from "./CodeEditor";
import { useCursorStore } from "../stores/ui";

export interface EditorHostProps {
	path: string;
	content: string;
	theme: "light" | "dark";
	status: string;
	lastError?: string;
	onChange: (content: string) => void;
}

export default function EditorHost(props: EditorHostProps) {
	// 切换文档时光标显示重置
	useEffect(() => {
		useCursorStore.getState().set(1, 1);
	}, [props.path]);

	if (props.status === "loading") {
		return <div className="editor-loading">⏳ 正在读取文件…</div>;
	}
	return <CodeEditor {...props} initialContent={props.content} />;
}
