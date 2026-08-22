use lofty::{
    file::{AudioFile, TaggedFileExt},
    probe::Probe,
    tag::Accessor,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

mod ai_analysis;
mod ai_worker;
mod mpv_runtime;
mod waveform;

struct ProgramState(Mutex<Value>);
struct MediaMetadataCache(Mutex<HashMap<PathBuf, CachedMediaMetadata>>);

#[tauri::command]
fn mpv_runtime_status(
    state: tauri::State<mpv_runtime::MpvManager>,
) -> Result<mpv_runtime::MpvRuntimeStatus, String> {
    mpv_runtime::runtime_status(&state)
}

#[tauri::command]
fn mpv_deck_load(
    state: tauri::State<mpv_runtime::MpvManager>,
    deck: u8,
    path: String,
) -> Result<mpv_runtime::MpvDeckState, String> {
    mpv_runtime::load_deck(&state, deck, Path::new(&path))
}

#[tauri::command]
fn mpv_deck_switch_source(
    state: tauri::State<mpv_runtime::MpvManager>,
    deck: u8,
    path: String,
) -> Result<mpv_runtime::MpvDeckState, String> {
    mpv_runtime::switch_source_preserving_state(&state, deck, Path::new(&path))
}

#[tauri::command]
fn mpv_deck_set_paused(
    state: tauri::State<mpv_runtime::MpvManager>,
    deck: u8,
    paused: bool,
) -> Result<mpv_runtime::MpvDeckState, String> {
    mpv_runtime::set_paused(&state, deck, paused)
}

#[tauri::command]
fn mpv_deck_seek(
    state: tauri::State<mpv_runtime::MpvManager>,
    deck: u8,
    seconds: f64,
) -> Result<mpv_runtime::MpvDeckState, String> {
    mpv_runtime::seek(&state, deck, seconds)
}

#[tauri::command]
fn mpv_deck_set_volume(
    state: tauri::State<mpv_runtime::MpvManager>,
    deck: u8,
    volume: f64,
) -> Result<mpv_runtime::MpvDeckState, String> {
    mpv_runtime::set_volume(&state, deck, volume)
}

#[tauri::command]
fn mpv_deck_state(
    state: tauri::State<mpv_runtime::MpvManager>,
    deck: u8,
) -> Result<mpv_runtime::MpvDeckState, String> {
    mpv_runtime::deck_state(&state, deck)
}

#[tauri::command]
fn mpv_deck_shutdown(state: tauri::State<mpv_runtime::MpvManager>, deck: u8) -> Result<(), String> {
    mpv_runtime::shutdown_deck(&state, deck)
}

#[tauri::command]
async fn analyze_audio_waveform(
    app: tauri::AppHandle,
    state: tauri::State<'_, waveform::WaveformCache>,
    path: String,
    sample_count: usize,
) -> Result<waveform::AudioAnalysis, String> {
    let database_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("king-club.sqlite3");
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("waveforms");
    waveform::analyze(
        state.inner().clone(),
        PathBuf::from(path),
        sample_count,
        cache_directory,
        database_path,
    )
    .await
}

#[tauri::command]
async fn queue_audio_ai_analysis(
    app: tauri::AppHandle,
    path: String,
) -> Result<ai_analysis::AiAnalysisJob, String> {
    let database_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("king-club.sqlite3");
    let derived_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("analysis");
    ai_analysis::queue(PathBuf::from(path), database_path, derived_root).await
}

#[tauri::command]
fn list_audio_ai_jobs(app: tauri::AppHandle) -> Result<Vec<ai_analysis::AiAnalysisJob>, String> {
    let database_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("king-club.sqlite3");
    ai_analysis::list(&database_path)
}

#[tauri::command]
fn audio_ai_worker_status(
    state: tauri::State<ai_worker::AiWorkerManager>,
) -> Result<ai_worker::AiWorkerStatus, String> {
    ai_worker::status(&state)
}

#[tauri::command]
fn save_rhythm_correction(
    app: tauri::AppHandle,
    state: tauri::State<'_, waveform::WaveformCache>,
    path: String,
    sample_count: usize,
    bpm: f32,
    first_downbeat_seconds: f32,
    beats_per_bar: u8,
) -> Result<waveform::AudioAnalysis, String> {
    let database_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("king-club.sqlite3");
    waveform::save_rhythm_correction(
        state.inner().clone(),
        PathBuf::from(path),
        sample_count,
        database_path,
        waveform::RhythmCorrection {
            bpm,
            first_downbeat_seconds,
            beats_per_bar,
        },
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayInfo {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale_factor: f64,
    is_primary: bool,
    is_operator: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputWindowStatus {
    connected: bool,
    preview_mode: bool,
    window_visible: bool,
    monitor_index: Option<usize>,
    monitor_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MonitorIdentity {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl From<&tauri::Monitor> for MonitorIdentity {
    fn from(monitor: &tauri::Monitor) -> Self {
        Self {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        }
    }
}

fn same_monitor(left: &tauri::Monitor, right: &tauri::Monitor) -> bool {
    MonitorIdentity::from(left) == MonitorIdentity::from(right)
}

fn select_output_monitor(
    monitors: &[MonitorIdentity],
    operator: Option<MonitorIdentity>,
    requested_index: Option<usize>,
) -> Result<Option<usize>, String> {
    let operator = operator
        .ok_or_else(|| "无法识别主控台所在显示器，已停止输出以避免覆盖操作界面".to_string())?;

    if let Some(index) = requested_index {
        let monitor = monitors
            .get(index)
            .ok_or_else(|| "指定的显示器不存在".to_string())?;
        if *monitor == operator {
            return Err("所选显示器正在运行主控台，不能覆盖操作界面".to_string());
        }
        return Ok(Some(index));
    }

    Ok(monitors.iter().position(|monitor| *monitor != operator))
}

fn monitor_status(index: usize, monitor: &tauri::Monitor) -> OutputWindowStatus {
    OutputWindowStatus {
        connected: true,
        preview_mode: false,
        window_visible: true,
        monitor_index: Some(index),
        monitor_name: monitor.name().cloned(),
        width: Some(monitor.size().width),
        height: Some(monitor.size().height),
        message: "LED 第二屏已连接；C1 实时预览保持开启".to_string(),
    }
}

fn preview_status(monitor: &tauri::Monitor) -> OutputWindowStatus {
    OutputWindowStatus {
        connected: true,
        preview_mode: true,
        window_visible: false,
        monitor_index: None,
        monitor_name: monitor.name().cloned(),
        width: Some(monitor.size().width),
        height: Some(monitor.size().height),
        message: "当前为单屏模式，节目画面仅在 C1 实时预览；接入第二屏后将自动输出".to_string(),
    }
}

#[cfg(windows)]
fn remove_output_window_chrome(window: &tauri::WebviewWindow) -> Result<(), String> {
    use std::{ffi::c_void, mem::size_of};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_STYLE, WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    };

    const DWM_WINDOW_CORNER_PREFERENCE_DONOTROUND: u32 = 1;
    const DWMWA_COLOR_NONE: u32 = 0xffff_fffe;

    window
        .set_shadow(false)
        .map_err(|error| error.to_string())?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    // Tauri/WebView2 may leave overlapped-window style bits behind even when
    // decorations are disabled. Windows Shell then treats the LED surface like
    // an ordinary maximized window and its taskbar can remain above it. Force a
    // true popup surface before applying the physical monitor bounds.
    let style = unsafe { GetWindowLongW(hwnd.0, GWL_STYLE) } as u32;
    let popup_style = (style
        & !(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU))
        | WS_POPUP;
    unsafe {
        SetWindowLongW(hwnd.0, GWL_STYLE, popup_style as i32);
    }
    let corner_preference = DWM_WINDOW_CORNER_PREFERENCE_DONOTROUND;
    let border_color = DWMWA_COLOR_NONE;
    let corner_result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&corner_preference as *const u32).cast::<c_void>(),
            size_of::<u32>() as u32,
        )
    };
    if corner_result < 0 {
        return Err(format!(
            "无法关闭 LED 输出窗口圆角：HRESULT 0x{:08X}",
            corner_result as u32
        ));
    }
    let border_result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_BORDER_COLOR as u32,
            (&border_color as *const u32).cast::<c_void>(),
            size_of::<u32>() as u32,
        )
    };
    if border_result < 0 {
        return Err(format!(
            "无法关闭 LED 输出窗口边框：HRESULT 0x{:08X}",
            border_result as u32
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn enforce_output_window_bounds(
    window: &tauri::WebviewWindow,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::GetLastError,
        UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_SHOWWINDOW,
        },
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let result = unsafe {
        SetWindowPos(
            hwnd.0,
            HWND_TOPMOST,
            position.x,
            position.y,
            size.width as i32,
            size.height as i32,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    };
    if result == 0 {
        return Err(format!(
            "无法将 LED 输出窗口置于第二屏最上层：Win32 错误 {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn remove_output_window_chrome(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn enforce_output_window_bounds(
    _window: &tauri::WebviewWindow,
    _position: PhysicalPosition<i32>,
    _size: PhysicalSize<u32>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn list_displays(app: tauri::AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let primary = app.primary_monitor().map_err(|error| error.to_string())?;
    let operator = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| primary.clone());

    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| DisplayInfo {
            index,
            name: monitor
                .name()
                .cloned()
                .unwrap_or_else(|| format!("显示器 {}", index + 1)),
            width: monitor.size().width,
            height: monitor.size().height,
            x: monitor.position().x,
            y: monitor.position().y,
            scale_factor: monitor.scale_factor(),
            is_primary: primary
                .as_ref()
                .is_some_and(|item| same_monitor(item, monitor)),
            is_operator: operator
                .as_ref()
                .is_some_and(|item| same_monitor(item, monitor)),
        })
        .collect())
}

#[tauri::command]
fn open_output_window(
    app: tauri::AppHandle,
    monitor_index: Option<usize>,
) -> Result<OutputWindowStatus, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let primary = app.primary_monitor().map_err(|error| error.to_string())?;
    let operator = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or(primary);

    let monitor_identities: Vec<_> = monitors.iter().map(MonitorIdentity::from).collect();
    let operator_identity = operator.as_ref().map(MonitorIdentity::from);
    let target_index =
        select_output_monitor(&monitor_identities, operator_identity, monitor_index)?;

    if target_index.is_none() {
        let monitor = operator
            .as_ref()
            .ok_or_else(|| "无法识别主控台所在显示器".to_string())?;
        if let Some(window) = app.get_webview_window("output") {
            window
                .set_fullscreen(false)
                .map_err(|error| error.to_string())?;
            window.hide().map_err(|error| error.to_string())?;
        }
        return Ok(preview_status(monitor));
    }

    let index = target_index.expect("target index checked above");

    let monitor = &monitors[index];
    let position = PhysicalPosition::new(monitor.position().x, monitor.position().y);
    let size = PhysicalSize::new(monitor.size().width, monitor.size().height);

    if let Some(window) = app.get_webview_window("output") {
        window
            .set_fullscreen(false)
            .map_err(|error| error.to_string())?;
        window
            .set_decorations(false)
            .map_err(|error| error.to_string())?;
        window
            .set_resizable(false)
            .map_err(|error| error.to_string())?;
        window
            .set_closable(false)
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        window
            .set_skip_taskbar(true)
            .map_err(|error| error.to_string())?;
        window
            .set_title("KING CLUB LED Output")
            .map_err(|error| error.to_string())?;
        window
            .set_position(position)
            .map_err(|error| error.to_string())?;
        window.set_size(size).map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        remove_output_window_chrome(&window)?;
        enforce_output_window_bounds(&window, position, size)?;
        window
            .set_fullscreen(true)
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        remove_output_window_chrome(&window)?;
        enforce_output_window_bounds(&window, position, size)?;
    } else {
        let output_url = if cfg!(debug_assertions) {
            WebviewUrl::External(
                "http://localhost:1420/output.html"
                    .parse()
                    .map_err(|error| format!("无法解析开发版输出地址：{error}"))?,
            )
        } else {
            WebviewUrl::App("output.html".into())
        };
        let window = WebviewWindowBuilder::new(&app, "output", output_url)
            .title("KING CLUB LED Output")
            .position(position.x as f64, position.y as f64)
            .inner_size(size.width as f64, size.height as f64)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .build()
            .map_err(|error| error.to_string())?;
        window
            .set_decorations(false)
            .map_err(|error| error.to_string())?;
        window
            .set_position(position)
            .map_err(|error| error.to_string())?;
        window.set_size(size).map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        remove_output_window_chrome(&window)?;
        enforce_output_window_bounds(&window, position, size)?;
        window
            .set_fullscreen(true)
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        remove_output_window_chrome(&window)?;
        enforce_output_window_bounds(&window, position, size)?;
    }

    Ok(monitor_status(index, monitor))
}

#[tauri::command]
fn close_output_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("output") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn output_window_status(app: tauri::AppHandle) -> Result<OutputWindowStatus, String> {
    let Some(window) = app.get_webview_window("output") else {
        return Ok(OutputWindowStatus {
            connected: false,
            preview_mode: false,
            window_visible: false,
            monitor_index: None,
            monitor_name: None,
            width: None,
            height: None,
            message: "LED 第二屏未连接".to_string(),
        });
    };
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "无法读取 LED 输出窗口所在显示器".to_string())?;
    let operator = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or(app.primary_monitor().map_err(|error| error.to_string())?);
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    if operator
        .as_ref()
        .is_some_and(|item| same_monitor(item, &monitor))
    {
        if monitors.iter().any(|item| !same_monitor(item, &monitor)) {
            return Ok(OutputWindowStatus {
                connected: false,
                preview_mode: true,
                window_visible: window.is_visible().unwrap_or(false),
                monitor_index: None,
                monitor_name: monitor.name().cloned(),
                width: Some(monitor.size().width),
                height: Some(monitor.size().height),
                message: "已检测到第二屏，正在迁移节目输出".to_string(),
            });
        }
        if window.is_visible().map_err(|error| error.to_string())? {
            window
                .set_fullscreen(false)
                .map_err(|error| error.to_string())?;
            window.hide().map_err(|error| error.to_string())?;
        }
        return Ok(preview_status(&monitor));
    }
    let index = monitors
        .iter()
        .position(|item| same_monitor(item, &monitor))
        .unwrap_or(0);
    // Windows can raise a multi-monitor taskbar above a borderless window after
    // shell interaction. The existing five-second status heartbeat also repairs
    // the popup/fullscreen/topmost contract without stealing keyboard focus.
    let position = PhysicalPosition::new(monitor.position().x, monitor.position().y);
    let size = PhysicalSize::new(monitor.size().width, monitor.size().height);
    if !window.is_fullscreen().map_err(|error| error.to_string())? {
        window
            .set_fullscreen(true)
            .map_err(|error| error.to_string())?;
    }
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    remove_output_window_chrome(&window)?;
    enforce_output_window_bounds(&window, position, size)?;
    Ok(monitor_status(index, &monitor))
}

#[tauri::command]
fn set_program_state(
    app: tauri::AppHandle,
    state: tauri::State<ProgramState>,
    program: Value,
) -> Result<(), String> {
    *state.0.lock().map_err(|_| "无法锁定节目状态".to_string())? = program.clone();
    app.emit_to("output", "program-state", program)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_program_state(state: tauri::State<ProgramState>) -> Result<Value, String> {
    state
        .0
        .lock()
        .map(|program| program.clone())
        .map_err(|_| "无法读取节目状态".to_string())
}

#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    let mut families = font_kit::source::SystemSource::new()
        .all_families()
        .map_err(|error| error.to_string())?;
    families.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    families.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    Ok(families)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageAsset {
    name: String,
    category: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageLibrary {
    directory: String,
    items: Vec<ImageAsset>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalMediaAsset {
    name: String,
    category: String,
    path: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: Option<u64>,
    lyrics: Option<String>,
    lyrics_path: Option<String>,
    lyrics_modified_unix_ms: Option<u128>,
    vocals_path: Option<String>,
    accompaniment_path: Option<String>,
    size_bytes: u64,
    modified_unix_ms: u128,
}

fn lyrics_sidecar(audio_path: &Path) -> Option<PathBuf> {
    ["lrc", "LRC"]
        .into_iter()
        .map(|extension| audio_path.with_extension(extension))
        .find(|candidate| candidate.is_file())
}

fn decode_lyrics_file(path: &Path) -> Option<String> {
    const MAX_LYRICS_BYTES: u64 = 2 * 1024 * 1024;
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_LYRICS_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if let Ok(value) = String::from_utf8(bytes.clone()) {
        return Some(value);
    }
    let (value, _, _) = encoding_rs::GBK.decode(&bytes);
    Some(value.into_owned())
}

#[derive(Clone, Default)]
struct CachedMediaMetadata {
    size_bytes: u64,
    modified_unix_ms: u128,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalMediaLibrary {
    root_directory: String,
    video_directory: String,
    audio_directory: String,
    videos: Vec<LocalMediaAsset>,
    audio: Vec<LocalMediaAsset>,
}

fn collect_images(
    directory: &Path,
    root: &Path,
    images: &mut Vec<ImageAsset>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_images(&path, root, images)?;
            continue;
        }
        let supported = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif"
                )
            })
            .unwrap_or(false);
        if !supported {
            continue;
        }
        let category = path
            .parent()
            .and_then(|parent| parent.strip_prefix(root).ok())
            .and_then(|relative| relative.components().next())
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .filter(|name| matches!(name.as_str(), "背景" | "海报" | "欢迎" | "生日" | "活动"))
            .unwrap_or_else(|| "背景".to_string());
        images.push(ImageAsset {
            name: path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            category,
            path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(())
}

fn collect_media_files(
    directory: &Path,
    root: &Path,
    extensions: &[&str],
    default_category: &str,
    cache: &MediaMetadataCache,
    ready_artifacts: &HashMap<String, ai_analysis::ReadyAudioArtifacts>,
    media: &mut Vec<LocalMediaAsset>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_media_files(
                &path,
                root,
                extensions,
                default_category,
                cache,
                ready_artifacts,
                media,
            )?;
            continue;
        }
        let supported = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                let extension = extension.to_ascii_lowercase();
                extensions.iter().any(|supported| *supported == extension)
            })
            .unwrap_or(false);
        if !supported {
            continue;
        }
        let category = path
            .parent()
            .and_then(|parent| parent.strip_prefix(root).ok())
            .and_then(|relative| relative.components().next())
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| default_category.to_string());
        let file_name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        let size_bytes = metadata.len();
        let modified_unix_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);
        let cached = {
            let values = cache
                .0
                .lock()
                .map_err(|_| "无法读取媒体元数据缓存".to_string())?;
            values
                .get(&path)
                .filter(|value| {
                    value.size_bytes == size_bytes && value.modified_unix_ms == modified_unix_ms
                })
                .cloned()
        };
        let media_metadata = cached.unwrap_or_else(|| {
            let mut value = CachedMediaMetadata {
                size_bytes,
                modified_unix_ms,
                ..Default::default()
            };
            if let Ok(tagged_file) = Probe::open(&path).and_then(|probe| probe.read()) {
                let duration = tagged_file.properties().duration();
                if !duration.is_zero() {
                    value.duration_ms = u64::try_from(duration.as_millis()).ok();
                }
                if let Some(tag) = tagged_file
                    .primary_tag()
                    .or_else(|| tagged_file.first_tag())
                {
                    value.title = tag.title().map(|item| item.into_owned());
                    value.artist = tag.artist().map(|item| item.into_owned());
                    value.album = tag.album().map(|item| item.into_owned());
                }
            }
            if let Ok(mut values) = cache.0.lock() {
                values.insert(path.clone(), value.clone());
            }
            value
        });
        let canonical_path = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .into_owned();
        let derived_artifacts = ready_artifacts.get(&canonical_path);
        let lyrics_path = lyrics_sidecar(&path)
            .or_else(|| derived_artifacts.map(|artifacts| artifacts.lyrics_path.clone()));
        let lyrics_modified_unix_ms = lyrics_path.as_ref().and_then(|value| {
            fs::metadata(value)
                .ok()?
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|time| time.as_millis())
        });
        let lyrics = lyrics_path
            .as_ref()
            .and_then(|value| decode_lyrics_file(value));
        media.push(LocalMediaAsset {
            name: file_name,
            category,
            path: path.to_string_lossy().into_owned(),
            title: media_metadata.title,
            artist: media_metadata.artist,
            album: media_metadata.album,
            duration_ms: media_metadata.duration_ms,
            lyrics,
            lyrics_path: lyrics_path.map(|value| value.to_string_lossy().into_owned()),
            lyrics_modified_unix_ms,
            vocals_path: derived_artifacts
                .map(|artifacts| artifacts.vocals_path.to_string_lossy().into_owned()),
            accompaniment_path: derived_artifacts
                .map(|artifacts| artifacts.accompaniment_path.to_string_lossy().into_owned()),
            size_bytes,
            modified_unix_ms,
        });
    }
    Ok(())
}

fn media_root_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("KING_MEDIA_ROOT") {
            return Ok(PathBuf::from(path));
        }
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("media"))
}

#[tauri::command]
fn scan_image_library(app: tauri::AppHandle) -> Result<ImageLibrary, String> {
    let directory = media_root_directory(&app)?.join("images");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    collect_images(&directory, &directory, &mut items)?;
    items.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(ImageLibrary {
        directory: directory.to_string_lossy().into_owned(),
        items,
    })
}

#[tauri::command]
fn scan_media_library(
    app: tauri::AppHandle,
    cache: tauri::State<MediaMetadataCache>,
) -> Result<LocalMediaLibrary, String> {
    let root_directory = media_root_directory(&app)?;
    scan_media_root(root_directory, &cache)
}

fn scan_media_root(
    root_directory: PathBuf,
    cache: &MediaMetadataCache,
) -> Result<LocalMediaLibrary, String> {
    let video_directory = root_directory.join("videos");
    let audio_directory = root_directory.join("audio");
    fs::create_dir_all(&video_directory).map_err(|error| error.to_string())?;
    fs::create_dir_all(&audio_directory).map_err(|error| error.to_string())?;

    let mut videos = Vec::new();
    let mut audio = Vec::new();
    let database_path = root_directory
        .parent()
        .map(|directory| directory.join("king-club.sqlite3"));
    let ready_artifacts = database_path
        .as_deref()
        .map(ai_analysis::ready_artifacts_by_media_path)
        .transpose()?
        .unwrap_or_default();
    collect_media_files(
        &video_directory,
        &video_directory,
        &["mp4", "m4v", "mov", "webm"],
        "舞台",
        cache,
        &HashMap::new(),
        &mut videos,
    )?;
    collect_media_files(
        &audio_directory,
        &audio_directory,
        &["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"],
        "本地音乐",
        cache,
        &ready_artifacts,
        &mut audio,
    )?;
    videos.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    audio.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(LocalMediaLibrary {
        root_directory: root_directory.to_string_lossy().into_owned(),
        video_directory: video_directory.to_string_lossy().into_owned(),
        audio_directory: audio_directory.to_string_lossy().into_owned(),
        videos,
        audio,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProgramState(Mutex::new(Value::Null)))
        .manage(MediaMetadataCache(Mutex::new(HashMap::new())))
        .manage(waveform::WaveformCache::default())
        .manage(mpv_runtime::MpvManager::default())
        .manage(ai_worker::AiWorkerManager::default())
        .invoke_handler(tauri::generate_handler![
            scan_image_library,
            scan_media_library,
            list_system_fonts,
            list_displays,
            open_output_window,
            close_output_window,
            output_window_status,
            set_program_state,
            get_program_state,
            mpv_runtime_status,
            mpv_deck_load,
            mpv_deck_switch_source,
            mpv_deck_set_paused,
            mpv_deck_seek,
            mpv_deck_set_volume,
            mpv_deck_state,
            mpv_deck_shutdown,
            analyze_audio_waveform,
            save_rhythm_correction,
            queue_audio_ai_analysis,
            list_audio_ai_jobs,
            audio_ai_worker_status
        ])
        .setup(|app| {
            if let Err(error) = ai_worker::start(
                &app.handle().clone(),
                app.state::<ai_worker::AiWorkerManager>().inner(),
            ) {
                eprintln!("AI worker startup failed: {error}");
            }
            let main = if let Some(main) = app.get_webview_window("main") {
                main
            } else {
                let main_url = if cfg!(debug_assertions) {
                    WebviewUrl::External("http://localhost:1420/".parse()?)
                } else {
                    WebviewUrl::App("index.html".into())
                };
                WebviewWindowBuilder::new(app, "main", main_url)
                    .title("KING CLUB Broadcast Control")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(1180.0, 720.0)
                    .resizable(true)
                    .build()?
            };
            main.show()?;
            main.maximize()?;
            main.set_focus()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: i32, y: i32, width: u32, height: u32) -> MonitorIdentity {
        MonitorIdentity {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn one_display_keeps_program_in_operator_preview() {
        let operator = monitor(0, 0, 1920, 1080);
        assert_eq!(
            select_output_monitor(&[operator], Some(operator), None).unwrap(),
            None
        );
    }

    #[test]
    fn automatic_output_selects_a_non_operator_display() {
        let operator = monitor(0, 0, 1920, 1080);
        let led = monitor(1920, 0, 2048, 2304);
        assert_eq!(
            select_output_monitor(&[operator, led], Some(operator), None).unwrap(),
            Some(1)
        );
    }

    #[test]
    fn automatic_output_follows_the_operator_window_location() {
        let primary = monitor(0, 0, 1920, 1080);
        let operator = monitor(1920, 0, 1536, 960);
        assert_eq!(
            select_output_monitor(&[primary, operator], Some(operator), None).unwrap(),
            Some(0)
        );
    }

    #[test]
    fn output_never_accepts_the_operator_display() {
        let operator = monitor(0, 0, 1920, 1080);
        let error = select_output_monitor(&[operator], Some(operator), Some(0)).unwrap_err();
        assert!(error.contains("不能覆盖操作界面"));
    }

    #[test]
    fn stale_requested_display_is_rejected_after_disconnect() {
        let operator = monitor(0, 0, 1920, 1080);
        let error = select_output_monitor(&[operator], Some(operator), Some(1)).unwrap_err();
        assert!(error.contains("显示器不存在"));
    }

    #[test]
    fn missing_operator_identity_stops_output_safely() {
        let led = monitor(1920, 0, 2048, 2304);
        let error = select_output_monitor(&[led], None, None).unwrap_err();
        assert!(error.contains("停止输出"));
    }

    fn one_second_wav() -> Vec<u8> {
        let sample_rate = 44_100u32;
        let channels = 1u16;
        let bits_per_sample = 16u16;
        let data_size = sample_rate * u32::from(channels) * u32::from(bits_per_sample / 8);
        let mut wav = Vec::with_capacity((44 + data_size) as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(
            &(sample_rate * u32::from(channels) * u32::from(bits_per_sample / 8)).to_le_bytes(),
        );
        wav.extend_from_slice(&(channels * (bits_per_sample / 8)).to_le_bytes());
        wav.extend_from_slice(&bits_per_sample.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        wav.resize((44 + data_size) as usize, 0);
        wav
    }

    #[test]
    fn scans_audio_and_reads_real_duration() {
        let directory =
            std::env::temp_dir().join(format!("king-broadcast-media-test-{}", std::process::id()));
        let category = directory.join("测试分类");
        fs::create_dir_all(&category).expect("create test media directory");
        let path = category.join("真实测试.WAV");
        fs::write(&path, one_second_wav()).expect("write wav fixture");

        let cache = MediaMetadataCache(Mutex::new(HashMap::new()));
        let mut media = Vec::new();
        collect_media_files(
            &directory,
            &directory,
            &["wav"],
            "本地音乐",
            &cache,
            &HashMap::new(),
            &mut media,
        )
        .expect("scan media fixture");

        assert_eq!(media.len(), 1);
        assert_eq!(media[0].name, "真实测试");
        assert_eq!(media[0].category, "测试分类");
        assert!(media[0]
            .duration_ms
            .is_some_and(|value| (990..=1_010).contains(&value)));
        assert!(media[0].size_bytes > 44);

        fs::remove_dir_all(directory).expect("remove test media directory");
    }

    #[test]
    fn scans_reference_mp4_and_mp3_when_fixture_directory_is_provided() {
        let Some(fixture_directory) = std::env::var_os("KING_MEDIA_FIXTURE_DIR").map(PathBuf::from)
        else {
            return;
        };
        let directory = std::env::temp_dir().join(format!(
            "king-broadcast-reference-media-test-{}",
            std::process::id()
        ));
        let video_directory = directory.join("videos").join("舞台");
        let audio_directory = directory.join("audio").join("测试音乐");
        fs::create_dir_all(&video_directory).expect("create video fixture directory");
        fs::create_dir_all(&audio_directory).expect("create audio fixture directory");
        fs::copy(
            fixture_directory.join("flower.mp4"),
            video_directory.join("flower.mp4"),
        )
        .expect("copy MP4 fixture");
        fs::copy(
            fixture_directory.join("t-rex-roar.mp3"),
            audio_directory.join("t-rex-roar.mp3"),
        )
        .expect("copy MP3 fixture");
        let cache = MediaMetadataCache(Mutex::new(HashMap::new()));
        let library = scan_media_root(directory.clone(), &cache).expect("scan media root");

        assert_eq!(library.videos.len(), 1, "expected one MP4 fixture");
        assert_eq!(library.audio.len(), 1, "expected one MP3 fixture");
        assert_eq!(library.videos[0].category, "舞台");
        assert_eq!(library.audio[0].category, "测试音乐");
        assert!(library.videos[0].duration_ms.is_some_and(|value| value > 0));
        assert!(library.audio[0].duration_ms.is_some_and(|value| value > 0));
        assert!(library.videos[0].size_bytes > 0);
        assert!(library.audio[0].size_bytes > 0);

        fs::remove_dir_all(directory).expect("remove reference media test directory");
    }
}
