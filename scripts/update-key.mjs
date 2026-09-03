#!/usr/bin/env node
// ============================================================================
// 简阅 更新签名密钥管理（R-06）
// 生成 / 加载 ECDSA P-256 密钥对，产物写入 release/update-key.json（gitignore，勿提交）。
//
// 用法：node scripts/update-key.mjs
//   · 首次运行会生成新密钥，并在终端打印<b>公开 JWK</b> —— 请粘贴到客户端源码
//     src/utils/updateVerify.ts 的 UPGRADE_PUBLIC_JWK（同时设置非 null）。
//   · 之后每次发布由 scripts/release.ps1 自动使用同一把私钥为 latest.json 签名。
//   · ⚠️ 私钥请妥善备份：丢失后，历史已发布清单将无法再验签，只能重发。
// ============================================================================
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });
const keyFile = join(outDir, "update-key.json");

let publicJwk;
if (existsSync(keyFile)) {
  const j = JSON.parse(readFileSync(keyFile, "utf8"));
  if (!j.privateKey || !j.publicKey) {
    console.error("密钥文件格式异常：" + keyFile);
    process.exit(1);
  }
  publicJwk = j.publicKey;
  console.log("[update-key] 已存在密钥（未覆盖）：" + keyFile);
} else {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  writeFileSync(
    keyFile,
    JSON.stringify({ privateKey: privateJwk, publicKey: publicJwk }, null, 2) + "\n",
  );
  console.log("[update-key] 已生成新密钥：" + keyFile);
  console.log("[update-key] ⚠️ 请立即把 release/update-key.json 私钥另存备份；丢失后旧清单无法再验签。");
}

console.log("[update-key] 请把以下公钥粘贴到 src/utils/updateVerify.ts 的 UPGRADE_PUBLIC_JWK：");
console.log(JSON.stringify(publicJwk));
console.log("[update-key] 完成后把 UPGRADE_PUBLIC_JWK 由 null 改为该对象，客户端将强制验签。");
