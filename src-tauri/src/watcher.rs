//! 目录监听：notify（ReadDirectoryChangesW）→ 合并去重 → emit fs-event
//!
//! 关键设计：
//! - 事件循环线程持有 watcher，300ms 合并（同时周期性检测停止条件，R-12）
//! - 保存回环抑制：write_text_file 成功后记录 (path, mtime) 白名单，修改事件匹配 mtime 则跳过
//! - 多窗口：每个 (window label, root) 独立建立 watcher，互不覆盖（R-12）
//! - 源过滤：噪音目录（.git/node_modules/dist 等）的事件在 Rust 侧直接丢弃（R-23）
//! - 所有互斥体做 poison 恢复，避免单点 panic 级联（R-12）

use notify::{recommended_watcher, Event, RecursiveMode, RecommendedWatcher, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const FLUSH_INTERVAL: Duration = Duration::from_millis(300);
const IGNORE_TTL: Duration = Duration::from_secs(5);
/// 事件风暴下单批上限：超过立即 flush（不等 300ms）
const BATCH_HARD_LIMIT: usize = 512;

/// 噪音目录段（事件路径出现任一即丢弃，与 fs.rs 的 NOISE_DIRS 保持一致）
const NOISE_SEGMENTS: [&str; 7] = [
    "\\.git\\", "\\node_modules\\", "\\dist\\", "\\.svn\\", "\\.hg\\", "\\target\\", "\\.idea\\",
];

/// 保存回环抑制白名单 + 监听根目录列表
/// roots: (窗口 label, 根目录) —— 窗口销毁后对应监听自动退出
pub struct WatchState {
    pub ignore: Mutex<HashMap<String, (u128, Instant)>>,
    pub roots: Mutex<Vec<(String, String)>>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            ignore: Mutex::new(HashMap::new()),
            roots: Mutex::new(Vec::new()),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct FsEventPayload {
    pub path: String,
    pub kind: String, // create / modify / remove / rename
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
}

/// 保存成功后调用：把 (path, mtime) 加入白名单，抑制本次写入触发的 modify 事件
pub fn register_saved(app: &AppHandle, path: &str) {
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(t) = meta.modified() {
            if let Ok(n) = t.duration_since(UNIX_EPOCH) {
                if let Some(state) = app.try_state::<WatchState>() {
                    state
                        .ignore
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(path.to_owned(), (n.as_nanos(), Instant::now()));
                }
            }
        }
    }
}

/// 事件路径是否位于噪音目录内（源过滤，R-23）
fn is_noise_path(path: &str) -> bool {
    NOISE_SEGMENTS.iter().any(|seg| path.contains(seg))
}

#[tauri::command]
pub fn start_watch(
    window: tauri::WebviewWindow,
    app: AppHandle,
    path: String,
    state: State<'_, WatchState>,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("不是有效的目录".into());
    }
    let label = window.label().to_owned();
    // 幂等：同 (窗口, 路径) 已监听 → 直接成功（R-12：键含 label，同目录不同窗口各自监听）
    if state
        .roots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(l, r)| l == &label && r == &path)
    {
        return Ok(());
    }
    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();
    let mut watcher = recommended_watcher(
        move |res: Result<Event, notify::Error>| {
            // 源过滤：噪音事件不进入通道（省 IPC 与前端计算）
            if let Ok(ev) = &res {
                if ev.paths.iter().any(|p| is_noise_path(&p.to_string_lossy())) {
                    return;
                }
            }
            let _ = tx.send(res);
        },
    )
    .map_err(|e| format!("创建监听器失败: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败: {e}"))?;
    state
        .roots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((label.clone(), path.clone()));
    // watcher move 进线程保活；线程退出时自动 drop 停止监听
    std::thread::spawn(move || watch_loop(rx, app, label, path, watcher));
    Ok(())
}

#[tauri::command]
pub fn stop_watch(
    window: tauri::WebviewWindow,
    path: String,
    state: State<'_, WatchState>,
) -> Result<(), String> {
    let label = window.label().to_owned();
    state
        .roots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(l, r)| !(l == &label && r == &path));
    Ok(())
}

/// 停止全部监听（关闭工作区用）
#[tauri::command]
pub fn stop_all_watches(state: State<'_, WatchState>) -> Result<(), String> {
    state.roots.lock().unwrap_or_else(|e| e.into_inner()).clear();
    Ok(())
}

fn watch_loop(
    rx: mpsc::Receiver<Result<Event, notify::Error>>,
    app: AppHandle,
    label: String,
    root: String,
    _watcher: RecommendedWatcher,
) {
    let mut pending: Vec<Event> = Vec::new();
    let mut last_flush = Instant::now();
    loop {
        // R-12：每次循环先查停止条件（事件风暴下也能及时退出）
        if !is_current_root(&app, &root, &label) {
            break;
        }
        // 排空已就绪事件
        loop {
            match rx.try_recv() {
                Ok(Ok(ev)) => pending.push(ev),
                Ok(Err(_)) => {}
                Err(_) => break,
            }
        }
        // 到达 300ms 或单批超限 → flush
        if !pending.is_empty()
            && (pending.len() >= BATCH_HARD_LIMIT || last_flush.elapsed() >= FLUSH_INTERVAL)
        {
            let batch: Vec<Event> = std::mem::take(&mut pending);
            flush(&app, batch);
            last_flush = Instant::now();
        }
        // 短暂等待，同时让出 CPU；disconnected 则退出
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(ev)) => pending.push(ev),
            Ok(Err(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// root 是否仍在监听列表，且其所属窗口存活（窗口销毁 → 返回 false → 线程退出，防泄漏）
fn is_current_root(app: &AppHandle, root: &str, label: &str) -> bool {
    let state = app.state::<WatchState>();
    let roots = state.roots.lock().unwrap_or_else(|e| e.into_inner());
    let found = roots.iter().any(|(l, r)| l == label && r == root);
    if !found {
        return false;
    }
    app.get_webview_window(label).is_some()
}

/// 合并去重并发射事件
fn flush(app: &AppHandle, events: Vec<Event>) {
    let mut merged: HashMap<String, FsEventPayload> = HashMap::new();
    let state = app.state::<WatchState>();
    // Windows 后端把重命名拆成 From/To 两个单路径事件，先收集后按同父目录配对
    let mut rename_from: Vec<String> = Vec::new();
    let mut rename_to: Vec<String> = Vec::new();

    for ev in events {
        match ev.kind {
            notify::EventKind::Modify(notify::event::ModifyKind::Name(mode)) => {
                use notify::event::RenameMode;
                for p in &ev.paths {
                    let path = p.to_string_lossy().into_owned();
                    match mode {
                        RenameMode::From => rename_from.push(path),
                        RenameMode::To => rename_to.push(path),
                        RenameMode::Both => {
                            if let Some(t) = ev.paths.get(1) {
                                let to = t.to_string_lossy().into_owned();
                                if let Some(f) = ev.paths.first() {
                                    let from = f.to_string_lossy().into_owned();
                                    merged.insert(
                                        from.clone(),
                                        FsEventPayload {
                                            path: to,
                                            kind: "rename".into(),
                                            from_path: Some(from),
                                        },
                                    );
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            notify::EventKind::Create(_) => {
                for p in &ev.paths {
                    let path = p.to_string_lossy().into_owned();
                    merged.insert(
                        path.clone(),
                        FsEventPayload {
                            path,
                            kind: "create".into(),
                            from_path: None,
                        },
                    );
                }
            }
            notify::EventKind::Remove(_) => {
                for p in &ev.paths {
                    let path = p.to_string_lossy().into_owned();
                    merged.insert(
                        path.clone(),
                        FsEventPayload {
                            path,
                            kind: "remove".into(),
                            from_path: None,
                        },
                    );
                }
            }
            notify::EventKind::Modify(_) => {
                for p in &ev.paths {
                    let path = p.to_string_lossy().into_owned();
                    if is_own_write(&state, &path) {
                        continue; // 保存回环抑制
                    }
                    let keep_create = matches!(merged.get(&path), Some(e) if e.kind == "create");
                    if keep_create {
                        continue;
                    }
                    merged.insert(
                        path.clone(),
                        FsEventPayload {
                            path,
                            kind: "modify".into(),
                            from_path: None,
                        },
                    );
                }
            }
            _ => continue,
        }
    }

    // 配对 rename：From 与 To 同父目录
    for to in rename_to {
        let to_parent = Path::new(&to)
            .parent()
            .map(|p| p.to_string_lossy().into_owned());
        let pos = rename_from.iter().position(|f| {
            Path::new(f)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                == to_parent
        });
        if let Some(idx) = pos {
            let from = rename_from.remove(idx);
            merged.insert(
                from.clone(),
                FsEventPayload {
                    path: to,
                    kind: "rename".into(),
                    from_path: Some(from),
                },
            );
        } else {
            merged.insert(
                to.clone(),
                FsEventPayload {
                    path: to,
                    kind: "rename".into(),
                    from_path: None,
                },
            );
        }
    }
    for from in rename_from {
        merged.insert(
            from.clone(),
            FsEventPayload {
                path: from,
                kind: "rename".into(),
                from_path: None,
            },
        );
    }

    // 清理过期白名单
    state
        .ignore
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, (_, at)| at.elapsed() < IGNORE_TTL);

    if merged.is_empty() {
        return;
    }
    let payload: Vec<FsEventPayload> = merged.into_values().collect();
    #[cfg(debug_assertions)]
    for e in &payload {
        println!(
            "[watch] {} {} {}",
            e.kind,
            e.path,
            e.from_path.as_deref().unwrap_or("")
        );
    }
    let _ = app.emit("fs-event", payload);
}

/// 判断 modify 事件是否来自「自己保存」：路径 + mtime 都在白名单中
fn is_own_write(state: &WatchState, path: &str) -> bool {
    let guard = state.ignore.lock().unwrap_or_else(|e| e.into_inner());
    let Some((mtime, at)) = guard.get(path) else {
        return false;
    };
    if at.elapsed() >= IGNORE_TTL {
        return false;
    }
    match std::fs::metadata(path) {
        Ok(meta) => match meta.modified() {
            Ok(t) => match t.duration_since(UNIX_EPOCH) {
                Ok(n) => n.as_nanos() == *mtime,
                Err(_) => false,
            },
            Err(_) => false,
        },
        Err(_) => false,
    }
}
