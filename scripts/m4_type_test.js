// M4 验收：真实键入测试（聚焦编辑器 → Input.insertText → 校验 dirty + 大纲实时更新）
// 用法：node scripts/m4_type_test.js <port> <文本>
const port = process.argv[2];
const text = process.argv[3] ?? "## 新章节 从CDP键入";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const targets = await (
		await fetch(`http://127.0.0.1:${port}/json/list`)
	).json();
	const page = targets.find((t) => t.webSocketDebuggerUrl);
	if (!page) {
		console.error("NO_PAGE");
		process.exit(1);
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error("ws connect failed"));
	});
	let id = 0;
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const mid = ++id;
			const handler = (m) => {
				let d;
				try {
					d = JSON.parse(m.data);
				} catch {
					return;
				}
				if (d.id === mid) {
					ws.removeEventListener("message", handler);
					resolve(d);
				}
			};
			ws.addEventListener("message", handler);
			ws.send(JSON.stringify({ id: mid, method, params }));
		});

	// 1. 聚焦编辑器并把光标移到文档末尾（借用当前 selection 的 near 构造）
	await send("Runtime.evaluate", {
		expression: `(() => { const v = window.__stores.md.getState().api.getView(); v.focus(); const end = v.state.doc.content.size; v.dispatch(v.state.tr.setSelection(v.state.tr.selection.constructor.near(v.state.doc.resolve(end)))); return end; })()`,
		awaitPromise: true,
	});
	await sleep(300);
	// 1.5 先回车（新段落），再输入标题才能触发 inputrule 转 heading
	for (const type of ["keyDown", "keyUp"]) {
		await send("Input.dispatchKeyEvent", {
			type,
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13,
		});
	}
	await sleep(200);
	// 2. 真实键入（走浏览器输入管线，ProseMirror 原生处理）
	await send("Input.insertText", { text });
	await sleep(400);
	// 3. 校验：dirty + 大纲实时更新 + 内容尾部
	const r = await send("Runtime.evaluate", {
		expression: `(() => { const T = window.__stores.tabs.getState(); const M = window.__stores.md.getState(); const doc = T.tabs.find(x=>x.path.includes('readme.md')); return { status: doc.status, tocTail: M.toc.map(i=>i.text).slice(-3), contentTail: doc.content.slice(-60) }; })()`,
		returnByValue: true,
		awaitPromise: true,
	});
	console.log(JSON.stringify(r.result?.result?.value ?? r, null, 1));
	ws.close();
})().catch((e) => {
	console.error("ERR", e.message);
	process.exit(1);
});
