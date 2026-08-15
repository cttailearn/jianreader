//! 图片查看器（M7）：asset 协议加载 + 滚轮缩放 + 双击适应 + 拖拽平移 + 信息栏
//! 图片为二进制文件，不做文本解码；只读展示

import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatSize } from "./FileTree";

export default function ImageViewer({
	path,
	size,
	name,
}: {
	path: string;
	size: number;
	name: string;
}) {
	const [scale, setScale] = useState(1);
	const [fit, setFit] = useState(true);
	const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
	const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ x: 0, y: 0 });

	// 图片加载完成 → 记录原始尺寸
	const onLoad = () => {
		const el = imgRef.current;
		if (el) setDim({ w: el.naturalWidth, h: el.naturalHeight });
	};

	// 滚轮缩放（Ctrl+滚轮或直接滚轮）
	const onWheel = useCallback((e: React.WheelEvent) => {
		e.preventDefault();
		setFit(false);
		setScale((s) => Math.min(Math.max(s * (e.deltaY < 0 ? 1.12 : 0.89), 0.05), 16));
	}, []);

	// 双击：适应窗口
	const onDoubleClick = () => {
		setFit(true);
		setScale(1);
		setPos({ x: 0, y: 0 });
	};

	// 拖拽平移
	const onPointerDown = (e: React.PointerEvent) => {
		if (e.button !== 0) return;
		setDrag({ x: e.clientX - pos.x, y: e.clientY - pos.y });
		const onMove = (ev: PointerEvent) => {
			setPos({ x: ev.clientX - (drag?.x ?? 0), y: ev.clientY - (drag?.y ?? 0) });
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setDrag(null);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	// 适应窗口尺寸计算
	useEffect(() => {
		if (!fit || !dim) return;
		const wrap = wrapRef.current;
		if (!wrap) return;
		const w = wrap.clientWidth - 80;
		const h = wrap.clientHeight - 120;
		setScale(Math.min(w / dim.w, h / dim.h, 1));
	}, [fit, dim]);

	// 快捷键：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 适应
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!e.ctrlKey) return;
			const k = e.key.toLowerCase();
			if (k === "=" || k === "+") {
				e.preventDefault();
				setFit(false);
				setScale((s) => Math.min(s * 1.2, 16));
			} else if (k === "-") {
				e.preventDefault();
				setFit(false);
				setScale((s) => Math.max(s / 1.2, 0.05));
			} else if (k === "0") {
				e.preventDefault();
				onDoubleClick();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fit, dim]);

	return (
		<div className="image-viewer" ref={wrapRef} onWheel={onWheel}>
			<div
				className="image-viewer-stage"
				onPointerDown={onPointerDown}
				style={{ cursor: drag ? "grabbing" : "grab" }}
			>
				<img
					ref={imgRef}
					className="image-viewer-img"
					src={convertFileSrc(path)}
					alt={name}
					onLoad={onLoad}
					onDoubleClick={onDoubleClick}
					draggable={false}
					style={{
						transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
					}}
				/>
			</div>
			<div className="image-viewer-info">
				<span>{name}</span>
				{dim && (
					<span>
						{dim.w} × {dim.h}
					</span>
				)}
				<span>{formatSize(size)}</span>
				<span>{Math.round(scale * 100)}%</span>
				<span className="image-viewer-hint">滚轮缩放 · 双击适应 · 拖动平移</span>
			</div>
		</div>
	);
}
