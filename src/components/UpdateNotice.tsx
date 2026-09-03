//! 新版本提示横幅（右下角，非侵入）：启动自动检查发现新版本时出现，点击前往 Release 页手动安装

import { useUpdaterStore } from "../stores/updater";

export default function UpdateNotice() {
	const status = useUpdaterStore((s) => s.status);
	const banner = useUpdaterStore((s) => s.banner);
	const info = useUpdaterStore((s) => s.info);
	const openRelease = useUpdaterStore((s) => s.openRelease);
	const dismissBanner = useUpdaterStore((s) => s.dismissBanner);

	if (!banner || status !== "available" || !info) return null;

	return (
		<div className="update-notice" role="status">
			<div className="update-notice-icon">🔄</div>
			<div className="update-notice-text">
				<div className="update-notice-title">发现新版本 v{info.version}</div>
				{info.notes && (
					<div className="update-notice-notes">
						{info.notes.replace(/\r?\n/g, " ").slice(0, 60)}
						{info.notes.length > 60 ? "…" : ""}
					</div>
				)}
			</div>
			<button
				className="novel-btn update-notice-btn"
				onClick={() => void openRelease()}
				title="用系统浏览器打开 GitHub Release 页手动下载安装"
			>
				前往下载
			</button>
			<button
				className="icon-btn update-notice-close"
				onClick={dismissBanner}
				title="忽略本次"
			>
				✕
			</button>
		</div>
	);
}
