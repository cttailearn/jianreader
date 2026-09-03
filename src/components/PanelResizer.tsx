//! 面板宽度拖拽把手：按住把手左右拖动调整相邻面板宽度
//! side="left"：把手在左栏右侧（拖动时左栏增宽）
//! side="right"：把手在右栏左侧（拖动时右栏增宽）

import { useRef } from "react";
import { usePanelsStore, MIN_PANEL_W, MAX_PANEL_W } from "../stores/panels";

export default function PanelResizer({ side }: { side: "left" | "right" }) {
	const dragging = useRef(false);

	const onPointerDown = (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragging.current = true;
		const startX = e.clientX;
		const st = usePanelsStore.getState();
		const startW = side === "left" ? st.leftW : st.rightW;
		const setW = side === "left" ? st.setLeftW : st.setRightW;

		const onMove = (ev: PointerEvent) => {
			if (!dragging.current) return;
			const dx = ev.clientX - startX;
			const w = side === "left" ? startW + dx : startW - dx;
			setW(Math.min(Math.max(w, MIN_PANEL_W), MAX_PANEL_W));
		};
		const onUp = () => {
			dragging.current = false;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	};

	return (
		<div
			className={`panel-resizer ${side}`}
			role="separator"
			aria-orientation="vertical"
			aria-label={side === "left" ? "调整左侧面板宽度" : "调整右侧面板宽度"}
			onPointerDown={onPointerDown}
			title="拖动调整宽度"
		/>
	);
}
