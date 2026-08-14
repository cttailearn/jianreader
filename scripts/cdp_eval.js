// CDP 驱动 WebView2：执行 JS 并打印结果（Node 24 内置 WebSocket/fetch）
// 用法：node scripts/cdp_eval.js <port> <expression>
// 环境要求：应用以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=<port>" 启动
const port = process.argv[2];
const expr = process.argv[3];

if (!port || !expr) {
	console.error("usage: node cdp_eval.js <port> <expression>");
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	// WebView2 的 /json/list 或 /json 都可能有效，都试
	let targets = null;
	for (const ep of ["/json/list", "/json"]) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}${ep}`);
			if (res.ok) {
				targets = await res.json();
				break;
			}
		} catch {
			/* try next */
		}
	}
	if (!targets) {
		console.error("NO_CDP_TARGETS");
		process.exit(1);
	}
	const list = Array.isArray(targets) ? targets : [targets];
	const page = list.find((t) => t.webSocketDebuggerUrl);
	if (!page) {
		console.error("NO_PAGE");
		process.exit(1);
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error("ws connect failed"));
	});
	const result = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			console.error("EVAL_TIMEOUT");
			process.exit(1);
		}, 25000);
		ws.onmessage = (m) => {
			const d = JSON.parse(m.data);
			if (d.id === 1) {
				clearTimeout(timer);
				resolve(d);
			}
		};
		ws.send(
			JSON.stringify({
				id: 1,
				method: "Runtime.evaluate",
				params: {
					expression: expr,
					awaitPromise: true,
					returnByValue: true,
				},
			}),
		);
	});
	if (result.result?.exceptionDetails) {
		console.error("EXCEPTION:", JSON.stringify(result.result.exceptionDetails));
		process.exit(1);
	}
	const v = result.result?.result?.value;
	console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
	ws.close();
	await sleep(50);
})().catch((e) => {
	console.error("ERR", e.message);
	process.exit(1);
});
