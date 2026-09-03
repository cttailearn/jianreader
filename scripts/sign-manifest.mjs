#!/usr/bin/env node
// ============================================================================
// 简阅 更新清单签名（R-06）
// 对 latest.json 的规范摘要（version\nurl\nsha256\nsize，UTF-8）做 ECDSA P-256 / SHA-256 签名，
// 以 P1363 原始 r||s 形式（Node dsaEncoding:'ieee-p1363'）base64 写回 latest.json.signature。
// 客户端用 WebCrypto 以相同逻辑验签，杜绝「清单与安装包同源被整体替换」的伪造面。
//
// 用法：node scripts/sign-manifest.mjs -f <latest.json> -k <update-key.json>
// 注意：-k 私钥文件由 scripts/update-key.mjs 生成（release/update-key.json，gitignore）。
// ============================================================================
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const idx = (n) => args.indexOf(n);
const file = idx("-f") >= 0 ? args[idx("-f") + 1] : undefined;
const key = idx("-k") >= 0 ? args[idx("-k") + 1] : undefined;
if (!file || !key) {
  console.error("用法：node scripts/sign-manifest.mjs -f <latest.json> -k <update-key.json>");
  process.exit(1);
}
if (!existsSync(key)) {
  console.error("缺少签名私钥，请先执行：node scripts/update-key.mjs");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(file, "utf8"));
// 与客户端 canonicalManifest / verify-manifest.mjs 完全一致（仅签约 version + sha256）
const canonical = [
  String(manifest.version ?? ""),
  String(manifest.sha256 ?? ""),
].join("\n");

const keyObj = JSON.parse(readFileSync(key, "utf8"));
const { privateKey: privateJwk, publicKey: publicJwk } = keyObj;
const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
const signature = sign("sha256", Buffer.from(canonical, "utf8"), {
  key: privateKey,
  dsaEncoding: "ieee-p1363",
});

manifest.signature = signature.toString("base64");
writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[sign] 已签名：${file}`);
console.log(`[sign] 版本 ${manifest.version}，signature（P1363 r||s，base64，${signature.length}B）已写入。`);

// 一致性防护：公钥必须与客户端内置（src/utils/updateVerify.ts）一致，否则客户端将拒绝本次发布
const srcPath = join(ROOT, "src", "utils", "updateVerify.ts");
if (existsSync(srcPath)) {
  const src = readFileSync(srcPath, "utf8");
  const xOk = src.includes(publicJwk.x);
  const yOk = src.includes(publicJwk.y);
  if (!xOk || !yOk) {
    console.warn(
      `[sign] ⚠️ 本次签名所用公钥与内置 UPGRADE_PUBLIC_JWK 不一致（x=${xOk}, y=${yOk}）！` +
        "客户端将拒绝本次更新。请把 node scripts/update-key.mjs 输出的公钥粘贴到 src/utils/updateVerify.ts，或用回原私钥。",
    );
  } else {
    console.log("[sign] 公钥与客户端内置一致，客户端可正常验签。");
  }
}
