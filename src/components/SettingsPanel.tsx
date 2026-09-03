//! 设置面板（M9）：常规设置（主题/自动保存/隐藏文件/大文件高亮）+ 快捷键自定义（录制式）
//! 由 TopBar 齿轮按钮打开；打开期间屏蔽全局快捷键

import { useEffect, useState } from "react";
import { FONT_FAMILY_OPTIONS, useSettingsStore } from "../stores/settings";
import { useThemeStore } from "../stores/theme";
import { useTreeStore } from "../stores/tree";
import { useUpdaterStore } from "../stores/updater";
import {
	eventToCombo,
	KEY_ACTION_LABELS,
	useKeymapStore,
	type KeyAction,
} from "../stores/keymap";

function Switch({
	checked,
	onChange,
	label,
	desc,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
	desc?: string;
}) {
	return (
		<div className="settings-row">
			<div className="settings-row-text">
				<div className="settings-row-label">{label}</div>
				{desc && <div className="settings-row-desc">{desc}</div>}
			</div>
			<button
				className={"switch" + (checked ? " on" : "")}
				role="switch"
				aria-checked={checked}
				onClick={() => onChange(!checked)}
			>
				<span className="switch-knob" />
			</button>
		</div>
	);
}

export default function SettingsPanel() {
	const open = useSettingsStore((s) => s.panelOpen);
	const setPanel = useSettingsStore((s) => s.setPanelOpen);
	const settings = useSettingsStore((s) => s.settings);
	const setSettings = useSettingsStore((s) => s.set);
	const mode = useThemeStore((s) => s.mode);
	const toggleTheme = useThemeStore((s) => s.toggle);
	const keymap = useKeymapStore((s) => s.keymap);
	const setKey = useKeymapStore((s) => s.setKey);
	const resetKeys = useKeymapStore((s) => s.reset);
	const upd = useUpdaterStore();
	const updStatus = upd.status;
	const [recording, setRecording] = useState<KeyAction | null>(null);
	const [conflict, setConflict] = useState(false);

	// 录制捕获：面板打开时监听 keydown
	useEffect(() => {
		if (!open || !recording) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRecording(null);
				setConflict(false);
				return;
			}
			const combo = eventToCombo(e);
			if (!combo) return;
			const ok = setKey(recording, combo);
			setConflict(!ok);
			if (ok) {
				setRecording(null);
				setConflict(false);
			}
		};
		window.addEventListener("keydown", onKey, true); // 捕获阶段拦截
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, recording, setKey]);

	if (!open) return null;

	const actions = Object.keys(KEY_ACTION_LABELS) as KeyAction[];

	return (
		<div className="settings-overlay" onClick={() => setPanel(false)}>
			<div className="settings-panel" onClick={(e) => e.stopPropagation()}>
				<div className="settings-header">
					<span>设置</span>
					<button className="icon-btn" onClick={() => setPanel(false)} title="关闭">
						✕
					</button>
				</div>

				<div className="settings-section">通用</div>
				<div className="settings-row">
					<div className="settings-row-text">
						<div className="settings-row-label">主题</div>
						<div className="settings-row-desc">浅色 / 暗色（全局三联动）</div>
					</div>
					<button className="novel-btn" onClick={toggleTheme}>
						{mode === "light" ? "🌙 切换暗色" : "☀️ 切换浅色"}
					</button>
				</div>
				<Switch
					checked={settings.autoSave}
					onChange={(v) => setSettings({ autoSave: v })}
					label="自动保存"
					desc="内容修改 2 秒后自动写盘（默认关闭）"
				/>
				<Switch
					checked={settings.showHidden}
					onChange={(v) => {
						setSettings({ showHidden: v });
						// 立即按新设置刷新目录树（M9 审查）
						void useTreeStore.getState().refreshRoot();
					}}
					label="显示隐藏文件"
					desc="目录树显示 .git / node_modules / 以 . 开头的文件（默认隐藏）"
				/>
				<Switch
					checked={settings.largeFileHighlight}
					onChange={(v) => setSettings({ largeFileHighlight: v })}
					label="大文件语法高亮"
					desc=">3MB 文件也加载语法高亮（默认关闭以加快打开）"
				/>

				<div className="settings-section">阅读与编辑</div>
				<div className="settings-row">
					<div className="settings-row-text">
						<div className="settings-row-label">正文字号</div>
						<div className="settings-row-desc">
							代码编辑器与 Markdown 正文（小说阅读字号在其阅读设置中调整）
						</div>
					</div>
					<input
						type="range"
						min={12}
						max={24}
						step={0.5}
						value={settings.editorFontSize}
						onChange={(e) =>
							setSettings({ editorFontSize: Number(e.target.value) })
						}
						title={`${settings.editorFontSize}px`}
						style={{ width: 140, accentColor: "var(--accent)" }}
					/>
					<span className="settings-row-desc" style={{ minWidth: 34 }}>
						{settings.editorFontSize}px
					</span>
				</div>
				<div className="settings-row">
					<div className="settings-row-text">
						<div className="settings-row-label">正文/小说字体</div>
						<div className="settings-row-desc">
							作用于 Markdown 正文与小说阅读文字，立即生效
						</div>
					</div>
					<select
						className="novel-settings-select"
						value={settings.editorFontFamily}
						onChange={(e) => setSettings({ editorFontFamily: e.target.value })}
					>
						{FONT_FAMILY_OPTIONS.map((f) => (
							<option key={f.id} value={f.id}>
								{f.label}
							</option>
						))}
					</select>
				</div>

				<div className="settings-section">软件更新</div>
				<div className="settings-row">
					<div className="settings-row-text">
						<div className="settings-row-label">当前版本</div>
						<div className="settings-row-desc">
							{upd.currentVersion ? `v${upd.currentVersion}` : "—"}
							{upd.lastChecked
								? ` · 上次检查 ${new Date(upd.lastChecked).toLocaleTimeString()}`
								: ""}
						</div>
					</div>
					<button
						className="novel-btn"
						disabled={updStatus === "checking"}
						onClick={() => void upd.checkNow()}
					>
						{updStatus === "checking" ? "检查中…" : "检查更新"}
					</button>
				</div>
				<Switch
					checked={settings.autoCheckUpdate}
					onChange={(v) => setSettings({ autoCheckUpdate: v })}
					label="启动时自动检查"
					desc="启动后后台检查 GitHub Releases 是否有新版本"
				/>
				{updStatus === "available" && upd.info && (
					<div className="settings-row">
						<div className="settings-row-text">
							<div className="settings-row-label">
								🔄 发现新版本 v{upd.info.version}
							</div>
							{upd.info.notes && (
								<div className="settings-row-desc">
									{upd.info.notes.slice(0, 120)}
								</div>
							)}
						</div>
						<button
							className="novel-btn"
							onClick={() => void upd.openRelease()}
							title="用系统浏览器打开 GitHub Release 页手动下载安装"
						>
							前往下载
						</button>
					</div>
				)}
				{updStatus === "upToDate" && (
					<div className="settings-row-desc settings-update-note">
						✓ 已是最新版本
					</div>
				)}
				{updStatus === "error" && upd.error && (
					<div className="settings-update-row settings-update-error">
						<span className="settings-conflict">⚠️ {upd.error}</span>
						<button className="novel-btn" onClick={() => void upd.checkNow()}>
							重试
						</button>
					</div>
				)}

				<div className="settings-section">快捷键（点击按键即可修改）</div>
				{actions.map((a) => (
					<div className="settings-row" key={a}>
						<div className="settings-row-text">
							<div className="settings-row-label">{KEY_ACTION_LABELS[a]}</div>
						</div>
						<button
							className={"keycap" + (recording === a ? " recording" : "")}
							onClick={() => {
								setRecording(a);
								setConflict(false);
							}}
							title="点击后按下新组合键"
						>
							{recording === a
								? "按下新按键… (Esc 取消)"
								: keymap[a].split("+").map((p) => (
										<span key={p} className="keycap-part">
											{p}
										</span>
									))}
						</button>
					</div>
				))}
				{conflict && (
					<div className="settings-conflict">⚠️ 该组合键已被其它动作占用或无效</div>
				)}

				<div className="settings-footer">
					<button
						className="novel-btn"
						onClick={() => {
							resetKeys();
							setConflict(false);
						}}
					>
						恢复默认快捷键
					</button>
				</div>
			</div>
		</div>
	);
}
