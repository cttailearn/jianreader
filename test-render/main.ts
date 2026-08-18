//! 临时渲染测试页：复现浅色模式代码块渲染（M11 排查用，不参与 App）
import { Crepe } from "@milkdown/crepe";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/nord.css";
import "@milkdown/crepe/theme/frame.css";
import "../src/styles/global.css";

const md = `# 标题一

这是一段正文。

\`\`\`ts
// 注释 comment
const x: number = 1;
function foo(a: string) {
  return "str" + a;
}
\`\`\`

| 列1 | 列2 | 列3 |
| --- | --- | --- |
| a   | b   | c   |
| d   | e   | f   |

行内 \`code\` 示例。
`;

const root = document.getElementById("root")!;
// 复现 MarkdownEditor 的修复：浅色显式 light 主题覆盖 Crepe 默认 oneDark
const theme =
	new URLSearchParams(location.search).get("theme") === "dark"
		? "dark"
		: "light";
document.documentElement.dataset.theme = theme;
const cmTheme =
	theme === "dark"
		? oneDark
		: EditorView.theme(
				{
					".cm-content": { color: "#1f2328" },
					".cm-gutters": { color: "#646a73" },
					".cm-activeLineGutter": { backgroundColor: "transparent" },
				},
				{ dark: false },
			);
const crepe = new Crepe({
	root,
	defaultValue: md,
	featureConfigs: {
		[Crepe.Feature.CodeMirror]: { theme: cmTheme },
	},
});
void crepe.create().then(() => {
	// 延迟等渲染完成后输出代码块计算样式（便于 headless dump-dom 检查）
	setTimeout(() => {
		const pre = root.querySelector(".milkdown-code-block");
		const cm = root.querySelector(".milkdown-code-block .cm-editor");
		const content = root.querySelector(".milkdown-code-block .cm-content");
		const line = root.querySelector(".milkdown-code-block .cm-line");
		const tbl = root.querySelector(".editor table");
		const th = root.querySelector(".editor th");
		const td = root.querySelector(".editor td");
		const info: string[] = [];
		const cs = (el: Element | null) => (el ? getComputedStyle(el) : null);
		const p = cs(pre);
		const c = cs(cm);
		const ct = cs(content);
		const l = cs(line);
		const t = cs(tbl);
		const th_ = cs(th);
		const td_ = cs(td);
		info.push("LIGHT THEME");
		info.push(`themeOnHtml=${document.documentElement.dataset.theme}`);
		info.push(`code-block bg=${p?.backgroundColor} text=${p?.color}`);
		info.push(`cm-editor bg=${c?.backgroundColor} color=${c?.color}`);
		info.push(`cm-content bg=${ct?.backgroundColor} color=${ct?.color}`);
		info.push(`cm-line bg=${l?.backgroundColor} color=${l?.color}`);
		info.push(`table bg=${t?.backgroundColor} border=${t?.borderTopColor}`);
		info.push(`th bg=${th_?.backgroundColor} color=${th_?.color}`);
		info.push(`td bg=${td_?.backgroundColor} color=${td_?.color}`);
		const box = document.createElement("pre");
		box.id = "style-report";
		box.textContent = info.join("\n");
		document.body.appendChild(box);
	}, 800);
});
