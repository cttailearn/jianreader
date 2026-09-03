//! R-06：更新清单数字签名校验（ECDSA P-256 / SHA-256，P1363 原始 r||s）
//!
//! 发布侧：`node scripts/update-key.mjs` 生成密钥并打印公开 JWK；
//!         `scripts/release.ps1` 发布时把 `scripts/sign-release.mjs` 生成的 `sig:` 行写入
//!         GitHub Release 备注；客户端从 `releases/latest` API 读取并在信任前验签。
//! 客户端：解析 GitHub Releases API（tag_name + assets[].digest + body 里的 sig）后用内置公钥验签，
//!         不通过则拒绝更新（fail-closed），杜绝「同一 GitHub 源被整体替换 / 仓库账号被接管」的伪造面。
//!
//! 引导模式：`UPGRADE_PUBLIC_JWK` 为 null 时跳过校验并告警（仅用于尚未生成密钥的初版）。
//! 上线前务必生成密钥并把公钥粘贴到下方。

/**
 * 发布者公钥（ECDSA P-256 / SHA-256）
 * 由本仓库首次运行 `node scripts/update-key.mjs` 生成并在此固化。
 * ⚠️ 私钥位于 release/update-key.json（gitignore），必须备份并随机器迁移；
 * 切勿被覆盖/删除，否则换钥匙后旧客户端将无法验签新版本。
 */
export const UPGRADE_PUBLIC_JWK: JsonWebKey = {
	kty: "EC",
	crv: "P-256",
	x: "v5y9QRNRctd_nRT3tzvP56vOv8roG7X__oRaL4wpjNs",
	y: "ziEXaDbTHchh5FqR2MrG7POG5paPidG06191uLQ2mPQ",
};

/** 规范摘要（仅签约 version + sha256，两字段足以支撑完整校验链）：
 *  下载后用「被签名的 sha256」比对文件哈希，URL/大小即使被改也改变不了校验结果。
 *  与 scripts/sign-release.mjs / sign-manifest.mjs 的 canonical 完全一致。 */
export function canonicalManifest(m: {
	version?: unknown;
	sha256?: unknown;
}): string {
	return [String(m.version ?? ""), String(m.sha256 ?? "")].join("\n");
}

/** base64 → ArrayBuffer（WebCrypto 输入） */
function b64ToArrayBuffer(b64: string): ArrayBuffer {
	const bin = atob(b64);
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf.buffer;
}

/**
 * 校验更新清单签名。通过 → resolve；不通过/缺签名 → reject（fail-closed）。
 * @param m 已经过基本字段校验的清单
 */
export async function verifyUpdateManifest(m: {
	version?: unknown;
	sha256?: unknown;
	signature?: unknown;
}): Promise<void> {
	if (!UPGRADE_PUBLIC_JWK) {
		console.warn(
			"[updater] 未配置更新签名公钥（引导模式），本次跳过签名校验。" +
				"上线前请执行 node scripts/update-key.mjs 并嵌入公钥。",
		);
		return;
	}
	if (typeof m.signature !== "string" || !m.signature) {
		throw new Error(
			"更新清单缺少数字签名（GitHub Release 备注未写入 sig）。请用 release.ps1（-Publish）发布带签名的版本后重试。",
		);
	}
	let sig: ArrayBuffer;
	try {
		sig = b64ToArrayBuffer(m.signature);
	} catch {
		throw new Error("更新清单签名格式无效");
	}
	const key = await crypto.subtle.importKey(
		"jwk",
		UPGRADE_PUBLIC_JWK,
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["verify"],
	);
	const data = new TextEncoder().encode(canonicalManifest(m));
	const ok = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		sig,
		data,
	);
	if (!ok) {
		throw new Error(
			"更新清单签名校验失败（内容疑似被篡改，或发布公钥与内置不一致），已拒绝更新。",
		);
	}
}
