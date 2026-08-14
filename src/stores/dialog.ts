//! 通用对话框：三键确认 / 文本输入（新建、重命名、删除确认等共用）
//! 自绘模态，风格随主题；Promise 风格 API

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

interface DialogState {
	open: DialogRequest | null;
	setOpen: (req: DialogRequest | null) => void;
}

export const useDialogStore = create<DialogState>((set) => ({
	open: null,
	setOpen: (req) => set({ open: req }),
}));

let pendingResolve: ((r: DialogResult) => void) | null = null;

/** 打开对话框，返回用户点击的按钮 id 与输入框内容 */
export function showDialog(req: DialogRequest): Promise<DialogResult> {
	return new Promise((resolve) => {
		pendingResolve = resolve;
		useDialogStore.getState().setOpen(req);
	});
}

/** 对话框组件回调 */
export function answerDialog(button: string, input: string) {
	if (pendingResolve) {
		pendingResolve({ button, input });
		pendingResolve = null;
	}
	useDialogStore.getState().setOpen(null);
}
