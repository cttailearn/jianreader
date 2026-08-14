//! 目录监听：notify（ReadDirectoryChangesW）→ 300ms 合并去重 → emit fs-event
//!
//! 关键设计：
//! - 事件循环线程持有 watcher，空闲 300ms 才 flush（事件风暴合并）
//! - 保存回环抑制：write_text_file 成功后记录 (path, mtime) 白名单，
//!   修改事件匹配 mtime 则跳过（区分「自己写」与「外部写」）
//! - 换目录时旧线程在下次 flush 前检测 root 变化并退出（优雅停止）

use notify::{recommended_watcher, Event, RecursiveMode, RecommendedWatcher, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const FLUSH_INTERVAL: Duration = Duration::from_millis(300);
const IGNORE_TTL: Duration = Duration::from_secs(5);

/// 保存回环抑制白名单 + 当前监听根目录
pub struct WatchState {
    pub ignore: Mutex<HashMap<String, (u128, Instant)>>,
    pub root: Mutex<Option<String>>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            ignore: Mutex::new(HashMap::new()),
            root: Mutex::new(None),
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
                        .unwrap()
                        .insert(path.to_owned(), (n.as_nanos(), Instant::now()));
                }
            }
        }
    }
}

#[tauri::command]
pub fn start_watch(
    app: AppHandle,
    path: String,
    state: State<'_, WatchState>,
) -> Result<(), String> {
    let _ = stop_watch_inner(&state);
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("不是有效的目录".into());
    }
    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();
    let mut watcher =
        recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| format!("创建监听器失败: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败: {e}"))?;
    *state.root.lock().unwrap() = Some(path.clone());
    // watcher move 进线程保活；线程退出时自动 drop 停止监听
    std::thread::spawn(move || watch_loop(rx, app, path, watcher));
    Ok(())
}

#[tauri::command]
pub fn stop_watch(state: State<'_, WatchState>) -> Result<(), String> {
    stop_watch_inner(&state)
}

fn stop_watch_inner(state: &WatchState) -> Result<(), String> {
    *state.root.lock().unwrap() = None;
    Ok(())
}

fn watch_loop(
    rx: mpsc::Receiver<Result<Event, notify::Error>>,
    app: AppHandle,
    root: String,
    _watcher: RecommendedWatcher,
) {
    let mut pending: Vec<Event> = Vec::new();
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(Ok(ev)) => pending.push(ev),
            Ok(Err(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // 根目录已切换/停止 → 退出线程（drop watcher）
                if !is_current_root(&app, &root) {
                    break;
                }
                if !pending.is_empty() {
                    let batch: Vec<Event> = std::mem::take(&mut pending);
                    flush(&app, batch);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn is_current_root(app: &AppHandle, root: &str) -> bool {
    app.state::<WatchState>()
        .root
        .lock()
        .unwrap()
        .as_deref()
        == Some(root)
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
                            // paths = [from, to]
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
                    // create 优先：新建文件伴随的写入不覆盖 create 事件
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

    // 配对 rename：From 与 To 同父目录（同一批次通常相邻出现）
    for to in rename_to {
        let to_parent = Path::new(&to).parent().map(|p| p.to_string_lossy().into_owned());
        let pos = rename_from.iter().position(|f| {
            Path::new(f).parent().map(|p| p.to_string_lossy().into_owned()) == to_parent
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
            // 配不上（To 单独到达）：发 unpaired，前端仅刷新目录树
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
    // 残留 From：同样发 unpaired
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
        .unwrap()
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
    let guard = state.ignore.lock().unwrap();
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
