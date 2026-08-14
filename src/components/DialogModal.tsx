//! 自绘模态对话框：三键确认 / 输入框（新建、重命名、删除确认、保存确认共用）
//! Enter 提交第一个按钮；Esc 或点遮罩 = cancel/最后按钮

import { useEffect, useRef, useState } from "react";
import { answerDialog, useDialogStore } from "../stores/dialog";

export default function DialogModal() {
	const open = useDialogStore((s) => s.open);
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setInput(open?.initialInput ?? "");
		// 输入框自动聚焦
		if (open?.inputLabel) {
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [open]);

	if (!open) return null;

	const cancelButton =
		open.buttons.find((b) => b.id === "cancel") ??
		open.buttons[open.buttons.length - 1];

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			e.preventDefault();
			answerDialog(open.buttons[0].id, input);
		} else if (e.key === "Escape") {
			answerDialog(cancelButton.id, input);
		}
	};

	return (
		<div
			className="dialog-overlay"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) answerDialog(cancelButton.id, input);
			}}
		>
			<div className="dialog-panel" onKeyDown={onKeyDown}>
				<div className="dialog-title">{open.title}</div>
				{open.message && <div className="dialog-message">{open.message}</div>}
				{open.inputLabel !== undefined && (
					<input
						ref={inputRef}
						className="dialog-input"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder={open.inputLabel}
					/>
				)}
				<div className="dialog-buttons">
					{open.buttons.map((b) => (
						<button
							key={b.id}
							className={"dialog-btn" + (b.danger ? " danger" : "")}
							onClick={() => answerDialog(b.id, input)}
						>
							{b.label}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
