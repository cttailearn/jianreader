//! 通用对话框：三键确认 / 文本输入（新建、重命名、删除确认等共用）
//! 自绘模态，风格随主题；Promise 风格 API
//! R-14：请求队列 + 唯一 id —— 并发多个确认框（如快速连续关闭两个 dirty 标签）时，
//! 前一个 Promise 也能被正确 resolve，不会永久挂起。

import { create } from "zustand";

export interface DialogButton {
	id: string;
	label: string;
	danger?: boolean;
}

export interface DialogRequest {
	title: string;
	message?: string;
	inputLabel?: string;
	initialInput?: string;
	buttons: DialogButton[];
}

export interface DialogResult {
	button: string;
	input: string;
}

interface PendingReq {
	id: number;
	req: DialogRequest;
	resolve: (r: DialogResult) => void;
}

interface DialogState {
	/** 当前展示的请求 + 其 id */
	open: { req: DialogRequest; id: number } | null;
	setOpen: (open: { req: DialogRequest; id: number } | null) => void;
}

export const useDialogStore = create<DialogState>((set) => ({
	open: null,
	setOpen: (open) => set({ open }),
}));

let seq = 0;
const pending: PendingReq[] = [];

/** 打开对话框，返回用户点击的按钮 id 与输入框内容（可并发调用） */
export function showDialog(req: DialogRequest): Promise<DialogResult> {
	return new Promise((resolve) => {
		const id = ++seq;
		pending.push({ id, req, resolve });
		// 当前无展示中的对话框 → 直接展示；否则排队等前一个应答后自动上屏
		if (!useDialogStore.getState().open) {
			openNext();
		}
	});
}

function openNext() {
	const p = pending[0];
	useDialogStore.getState().setOpen(p ? { req: p.req, id: p.id } : null);
}

/** 对话框组件回调：按 id 应答，随后自动展示队列中下一个 */
export function answerDialog(id: number, button: string, input: string) {
	const idx = pending.findIndex((p) => p.id === id);
	if (idx >= 0) {
		const [p] = pending.splice(idx, 1);
		p.resolve({ button, input });
	}
	useDialogStore.getState().setOpen(null);
	openNext();
}

/** 单例信号量：用于「关闭窗口」流程避免并发重入 */
let closeInFlight = false;
export function beginCloseFlow(): boolean {
	if (closeInFlight) return false;
	closeInFlight = true;
	return true;
}
export function endCloseFlow() {
	closeInFlight = false;
}
