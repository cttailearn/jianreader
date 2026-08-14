// 抓取 WebView2 控制台错误与运行时异常：连接 CDP 后重载页面并收集 5s 日志
// 用法：node scripts/cdp_console.js <port>
const port = process.argv[2];

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
		ws.send(JSON.stringify({ id: ++id, method, params }));
	ws.onmessage = (m) => {
		let d;
		try {
			d = JSON.parse(m.data);
		} catch {
			return;
		}
		if (
			d.method === "Runtime.consoleAPICalled" &&
			["error", "warning"].includes(d.params.type)
		) {
			const text = d.params.args
				.map((a) => a.value ?? a.description ?? "")
				.join(" ");
			console.log(`[console.${d.params.type}]`, text.slice(0, 500));
		}
		if (d.method === "Runtime.exceptionThrown") {
			const ex = d.params.exceptionDetails;
			console.log(
				"[exception]",
				ex.text,
				"|",
				(ex.exception?.description ?? "").slice(0, 600),
			);
		}
	};
	send("Runtime.enable");
	send("Page.enable");
	send("Page.reload", { ignoreCache: true });
	await new Promise((r) => setTimeout(r, 6000));
	ws.close();
	console.log("done");
})().catch((e) => {
	console.error("ERR", e.message);
	process.exit(1);
});
