#!/usr/bin/env node
// ============================================================================
// 简阅 发布备注签名（R-06，GitHub API 方案）
// 读取调用方保存的 GitHub Release JSON（由 release.ps1 通过 `gh api ... > file` 生成），
// 从资产取得浏览器下载 URL 与 SHA-256（assets[].digest），对 canonical="version\nsha256"
// 做 ECDSA P-256 / SHA-256 签名（P1363 r||s，base64），输出带 `sig: <base64>` 行的最终 release 备注。
// 客户端从 GitHub API 读取相同字段验签，无需单独维护 latest.json。
//
// 用法：node scripts/sign-release.mjs --json <release.json> [--key <update-key.json>]
//                                          [--notes <用户说明>] [--exe <本地安装包>] [--out <输出文件>]
//   示例（release.ps1 内部）：
//     gh api repositories/cttailearn/jianreader/releases/tags/v0.3.1 > release-info.json
//     node scripts/sign-release.mjs --json release-info.json --notes "更新说明" --out final-notes.txt
//     gh release edit v0.3.1 --notes (Get-Content final-notes.txt -Raw -Encoding UTF8)
// ============================================================================
import { createPrivateKey, createHash, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const val = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const jsonPath = val("--json");
const keyPath = val("--key") ?? join(ROOT, "release", "update-key.json");
const userNotes = val("--notes") ?? "";
const exePath = val("--exe");
const outPath = val("--out");

if (!jsonPath || !existsSync(jsonPath)) {
  console.error("用法：node scripts/sign-release.mjs --json <release.json> [--key <key>] [--notes <说明>]");
  process.exit(2);
}

async function main() {
  const rel = JSON.parse(readFileSync(jsonPath, "utf8"));
  const assets = rel.assets ?? [];
  const asset =
    assets.find(
      (a) =>
        /-setup_-?[0-9].*x64-setup\.exe$/i.test(a.name ?? "") &&
        !/portable/i.test(a.name ?? ""),
    ) ??
    assets.find(
      (a) => /\.exe$/i.test(a.name ?? "") && !/portable/i.test(a.name ?? ""),
    );
  if (!asset) {
    console.error("[sign-release] 未找到安装包资产（.exe）");
    process.exit(1);
  }
  const version = String(rel.tag_name ?? "").replace(/^v/i, "");
  let sha256 = String(asset.digest ?? "")
    .replace(/^sha256:/i, "")
    .toLowerCase();
  if (!sha256 && exePath && existsSync(exePath)) {
    sha256 = createHash("sha256").update(readFileSync(exePath)).digest("hex");
  }
  if (!sha256 || !version) {
    console.error("[sign-release] 缺少 version 或安装包 SHA-256（API 无 digest，且未提供 --exe）");
    process.exit(1);
  }

  const canonical = [version, sha256].join("\n");
  if (!existsSync(keyPath)) {
    console.error(`[sign-release] 缺少签名私钥：${keyPath}（先运行 node scripts/update-key.mjs）`);
    process.exit(1);
  }
  const { privateKey: privateJwk, publicKey } = JSON.parse(readFileSync(keyPath, "utf8"));
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(canonical, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");

  // 最终备注：有 --notes 用用户说明，否则保留原 body（去掉旧 sig 行），末尾追加当前 sig
  const body =
    typeof rel.body === "string"
      ? rel.body.replace(/(?:^|\n)\s*sig:\s*\S+/m, "").trim()
      : "";
  const finalNotes =
    (userNotes || body ? (userNotes || body) + "\n" : "") + `sig: ${signature}`;

  // 一致性自检：所用公钥与客户端内置 UPGRADE_PUBLIC_JWK 是否一致
  const srcPath = join(ROOT, "src", "utils", "updateVerify.ts");
  if (existsSync(srcPath)) {
    const src = readFileSync(srcPath, "utf8");
    if (!src.includes(publicKey.x) || !src.includes(publicKey.y)) {
      console.warn(
        "[sign-release] ⚠️ 签名公钥与客户端内置 UPGRADE_PUBLIC_JWK 不一致！客户端将拒绝本次更新。",
      );
    }
  }
  console.error(`[sign-release] 已签名：version=${version} sha256=${sha256.slice(0, 12)}…`);
  // 输出最终备注（含 sig 行）；指定 --out 时写入 UTF-8 文件（避免调用方 PS 重定向成 UTF-16）
  if (outPath) {
    writeFileSync(outPath, finalNotes, "utf8");
    console.error(`[sign-release] 已写入备注文件：${outPath}`);
  } else {
    console.log(finalNotes);
  }
}

main().catch((e) => {
  console.error("[sign-release] 失败：" + e.message);
  process.exit(1);
});
