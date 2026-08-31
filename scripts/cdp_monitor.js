// CDP 监听：连接后捕获全部 console 消息/异常，并周期性通过 pollExpr 采样页面状态
// 用法：node scripts/cdp_monitor.js <port> <durationMs> <pollExpr> <pollIntervalMs>
import fs from "node:fs";

const port = process.argv[2];
const dur = Number(process.argv[3] ?? 12000);
const pollExpr = process.argv[4];
const pollMs = Number(process.argv[5] ?? 1000);

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = Array.isArray(targets) ? targets.find((t) => t.webSocketDebuggerUrl) : null;
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

const started = Date.now();
const pollTimer = setInterval(async () => {
	if (pollExpr) {
		const p = new Promise((resolve) => {
			const mid = ++id;
			const h = (m) => {
				const d = JSON.parse(m.data);
				if (d.id === mid) {
					ws.removeEventListener("message", h);
					resolve(d.result?.result?.value ?? d.result?.exceptionDetails ?? null);
				}
			};
			ws.addEventListener("message", h);
			ws.send(
				JSON.stringify({
					id: mid,
					method: "Runtime.evaluate",
					params: { expression: pollExpr, returnByValue: true },
				}),
			);
		});
		const v = await p.catch(() => null);
		console.log(`POLL[${Math.round((Date.now() - started) / 1000)}s]:` + JSON.stringify(v));
	}
}, pollMs);

ws.onmessage = (m) => {
	const d = JSON.parse(m.data);
	if (d.method === "Runtime.consoleAPICalled") {
		const text = d.params.args
			.map((a) => a.value ?? a.description ?? "")
			.join(" ");
		console.log(`[console.${d.params.type}] ${text.slice(0, 700)}`);
	}
	if (d.method === "Runtime.exceptionThrown") {
		const ex = d.params.exceptionDetails;
		console.log(
			`[exception] ${ex.text} | ${(ex.exception?.description ?? "").slice(0, 700)}`,
		);
	}
};
send("Runtime.enable");
send("Page.enable");

await new Promise((r) => setTimeout(r, dur));
clearInterval(pollTimer);
ws.close();
console.log("done");
