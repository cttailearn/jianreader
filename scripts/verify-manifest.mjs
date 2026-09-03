#!/usr/bin/env node
// ============================================================================
// 简阅 更新清单验签工具（复刻客户端 WebCrypto 逻辑，用于发布前自检）
// 用法：node scripts/verify-manifest.mjs [-f <latest.json>] [-k <update-key.json>]
//   默认：release/latest.json + release/update-key.json
// 输出 PASS / FAIL（FAIL 以退出码 1 结束，便于 CI/脚本判断）。
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const idx = (n) => args.indexOf(n);
const file =
  idx("-f") >= 0 ? args[idx("-f") + 1] : join(ROOT, "release", "latest.json");
const key =
  idx("-k") >= 0 ? args[idx("-k") + 1] : join(ROOT, "release", "update-key.json");

if (!existsSync(file)) {
  console.error("清单不存在：" + file);
  process.exit(2);
}

const m = JSON.parse(readFileSync(file, "utf8"));
// 与客户端 canonicalManifest / sign-manifest.mjs 完全一致（仅签约 version + sha256）
const canonical = [
  String(m.version ?? ""),
  String(m.sha256 ?? ""),
].join("\n");

/** base64 -> ArrayBuffer（WebCrypto 输入） */
function b64ToBuffer(s) {
  const b = Buffer.from(s, "base64");
  const u = new Uint8Array(b.byteLength);
  u.set(b);
  return u.buffer;
}

(async () => {
  if (!existsSync(key)) {
    console.error("未找到密钥文件：请用 -k 指定 update-key.json");
    process.exit(2);
  }
  const { publicKey } = JSON.parse(readFileSync(key, "utf8"));
  if (typeof m.signature !== "string" || !m.signature) {
    console.error("FAIL：清单缺少 signature 字段（未签名）");
    process.exit(1);
  }
  let k;
  try {
    k = await webcrypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
  } catch (e) {
    console.error("FAIL：公钥导入失败 " + e.message);
    process.exit(1);
  }
  let sig;
  try {
    sig = b64ToBuffer(m.signature);
  } catch {
    console.error("FAIL：signature 不是合法 base64");
    process.exit(1);
  }
  const data = new TextEncoder().encode(canonical);
  let ok = false;
  try {
    ok = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      k,
      sig,
      data,
    );
  } catch (e) {
    console.error("FAIL：验签异常 " + e.message);
    process.exit(1);
  }
  if (!ok) {
    console.error("FAIL：签名不匹配（内容被篡改或密钥不符）：" + file);
    process.exit(1);
  }
  console.log(`PASS：${file} 签名有效（version=${m.version}）`);
})();
