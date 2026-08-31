// CDP 截图工具：连接应用 WebView，可选先执行 preExpr（返回结果打印到 stdout），再截图到 outfile
// 用法：node scripts/cdp_shot.js <port> <outfile.png> [preExpr]
import fs from "node:fs";

const port = process.argv[2];
const out = process.argv[3];
const preExpr = process.argv[4];

if (!port || !out) {
	console.error("usage: node cdp_shot.js <port> <outfile.png> [preExpr]");
	process.exit(1);
}

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
const pending = new Map();
const send = (method, params = {}) =>
	new Promise((resolve) => {
		const mid = ++id;
		pending.set(mid, resolve);
		ws.send(JSON.stringify({ id: mid, method, params }));
	});
ws.onmessage = (m) => {
	const d = JSON.parse(m.data);
	if (d.id && pending.has(d.id)) {
		const r = pending.get(d.id);
		pending.delete(d.id);
		r(d);
	}
};

if (preExpr) {
	const r = await send("Runtime.evaluate", {
		expression: preExpr,
		awaitPromise: true,
		returnByValue: true,
	});
	console.log(
		"PRE:" +
			JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? null),
	);
	await new Promise((r) => setTimeout(r, 450));
}
const shot = await send("Page.captureScreenshot", { format: "png" });
if (!shot.result?.data) {
	console.error("SHOT_FAIL", JSON.stringify(shot).slice(0, 400));
	process.exit(1);
}
fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("SAVED:" + out + ":" + shot.result.data.length);
console.log("done");
ws.close();
