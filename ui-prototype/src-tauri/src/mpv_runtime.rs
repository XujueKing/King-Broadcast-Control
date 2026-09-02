use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::{
    os::windows::{io::AsRawHandle, process::CommandExt},
    ptr,
};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MPV_START_TIMEOUT: Duration = Duration::from_secs(5);
const MPV_SEEK_SETTLE_TIMEOUT: Duration = Duration::from_millis(900);
const MPV_SEEK_FADE_STEPS: u32 = 6;
const MPV_SEEK_FADE_STEP_DELAY: Duration = Duration::from_millis(20);
const MPV_SEEK_POSITION_TOLERANCE_SECONDS: f64 = 0.25;
const MPV_SEEK_STABLE_READS: u8 = 2;
const RESCUE_PREVIEW_INSTANCE_OFFSET: u8 = 10;
const RESCUE_PREVIEW_DRIFT_SECONDS: f64 = 0.5;
const KINGCLUB_ANALOG_AUDIO_DEVICE_LABEL: &str = "扬声器 (Realtek(R) Audio)";
const MPV_AUDIO_OUTPUT_ARGS: [&str; 6] = [
    // The confirmed CH11/CH12 analog path and Qu-16 both run safely from a
    // fixed 48 kHz shared-mode stream. Keeping both Decks on the same format
    // avoids endpoint renegotiation between mixed-rate source files.
    "--ao=wasapi",
    "--audio-exclusive=no",
    "--audio-samplerate=48000",
    "--audio-channels=stereo",
    // Strong gapless mode freezes the first file's output parameters. That is
    // unsafe for a mixed local library; weak mode still avoids needless gaps.
    "--gapless-audio=weak",
    // The console is a broadcast player, so stability is more important than
    // sub-100 ms monitoring latency. A larger buffer absorbs USB scheduling
    // stalls without changing the Qu-16/DP448 gain structure.
    "--audio-buffer=0.5",
];
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

pub struct MpvManager(pub Mutex<MpvManagerInner>);

pub struct MpvManagerInner {
    binary: Option<PathBuf>,
    audio_device: Option<MpvAudioDevice>,
    output_trim_db: f64,
    instances: HashMap<u8, MpvInstance>,
    process_job: ProcessJob,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MpvAudioDevice {
    id: String,
    label: String,
}

struct MpvInstance {
    child: Child,
    pipe_path: String,
    loaded_path: Option<PathBuf>,
}

#[cfg(windows)]
struct ProcessJob(HANDLE);

#[cfg(not(windows))]
struct ProcessJob;

#[cfg(windows)]
unsafe impl Send for ProcessJob {}

impl ProcessJob {
    #[cfg(windows)]
    fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "无法创建 mpv Windows Job Object：{}",
                std::io::Error::last_os_error()
            ));
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe { CloseHandle(handle) };
            return Err(format!(
                "无法配置 mpv Windows Job Object：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(handle))
    }

    #[cfg(not(windows))]
    fn new() -> Result<Self, String> {
        Ok(Self)
    }

    #[cfg(windows)]
    fn assign(&self, child: &Child) -> Result<(), String> {
        let assigned = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
        if assigned == 0 {
            Err(format!(
                "无法把 mpv 加入 Windows Job Object：{}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    #[cfg(not(windows))]
    fn assign(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

impl Default for MpvManager {
    fn default() -> Self {
        let binary = discover_mpv_binary();
        let audio_device = binary.as_deref().and_then(discover_preferred_audio_device);
        let output_trim_db = preferred_output_trim_db(audio_device.as_ref());
        Self(Mutex::new(MpvManagerInner {
            binary,
            audio_device,
            output_trim_db,
            instances: HashMap::new(),
            process_job: ProcessJob::new().expect("create mpv process job"),
        }))
    }
}

impl Drop for MpvManagerInner {
    fn drop(&mut self) {
        for instance in self.instances.values_mut() {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvRuntimeStatus {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub audio_device: Option<String>,
    pub audio_device_label: Option<String>,
    pub output_trim_db: f64,
    pub active_decks: Vec<u8>,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvDeckState {
    pub deck: u8,
    pub running: bool,
    pub path: Option<String>,
    pub paused: bool,
    pub time_pos: f64,
    pub duration: f64,
    pub volume: f64,
    pub eof_reached: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvRescuePreviewState {
    pub deck: u8,
    pub running: bool,
    pub path: Option<String>,
    pub paused: bool,
    pub time_pos: f64,
    pub volume: f64,
    pub software_preview: bool,
    pub physical_audio_started: bool,
    pub message: String,
}

fn executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("KING_MPV_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(current_exe) = env::current_exe() {
        if let Some(directory) = current_exe.parent() {
            candidates.push(directory.join("mpv.exe"));
            candidates.push(directory.join("resources").join("mpv.exe"));
        }
    }
    if let Ok(current_directory) = env::current_dir() {
        for ancestor in current_directory.ancestors().take(4) {
            candidates.push(ancestor.join(".local-tools").join("mpv").join("mpv.exe"));
        }
        candidates.push(
            current_directory
                .join("ui-prototype")
                .join(".local-tools")
                .join("mpv")
                .join("mpv.exe"),
        );
    }
    candidates
}

fn discover_mpv_binary() -> Option<PathBuf> {
    executable_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .or_else(|| command_works(Path::new("mpv.exe")).then(|| PathBuf::from("mpv.exe")))
}

fn command_works(binary: &Path) -> bool {
    let mut command = Command::new(binary);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.status().is_ok_and(|status| status.success())
}

fn mpv_version(binary: &Path) -> Option<String> {
    let mut command = Command::new(binary);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    })
}

fn parse_audio_devices(output: &str) -> Vec<MpvAudioDevice> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix('\'')?;
            let (id, rest) = rest.split_once("' (")?;
            let label = rest.strip_suffix(')')?;
            Some(MpvAudioDevice {
                id: id.to_string(),
                label: label.to_string(),
            })
        })
        .collect()
}

fn select_preferred_audio_device(
    devices: &[MpvAudioDevice],
    requested: Option<&str>,
) -> Option<MpvAudioDevice> {
    if let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        if requested.eq_ignore_ascii_case("auto") {
            return None;
        }
        if let Some(device) = devices.iter().find(|device| {
            device.id.eq_ignore_ascii_case(requested)
                || device.label.eq_ignore_ascii_case(requested)
        }) {
            return Some(device.clone());
        }
    }

    // 2026-09-03现场复核：Qu-16 USB/CH3 会产生机械音和电流音；
    // Realtek 模拟输出进入 CH11/CH12 后失真立即消失。Never silently fall
    // back to the USB endpoint; an engineer can still opt in explicitly with
    // KING_MPV_AUDIO_DEVICE after that path has been repaired and revalidated.
    devices
        .iter()
        .find(|device| {
            device
                .label
                .eq_ignore_ascii_case(KINGCLUB_ANALOG_AUDIO_DEVICE_LABEL)
        })
        .cloned()
}

fn discover_preferred_audio_device(binary: &Path) -> Option<MpvAudioDevice> {
    let mut command = Command::new(binary);
    command
        .args(["--no-config", "--audio-device=help"])
        .stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    let devices = parse_audio_devices(&text);
    let requested = env::var("KING_MPV_AUDIO_DEVICE").ok();
    select_preferred_audio_device(&devices, requested.as_deref())
}

fn preferred_output_trim_db(_audio_device: Option<&MpvAudioDevice>) -> f64 {
    if let Ok(configured) = env::var("KING_MPV_OUTPUT_TRIM_DB") {
        if let Ok(value) = configured.trim().parse::<f64>() {
            if value.is_finite() {
                return value.clamp(-60.0, 0.0);
            }
        }
    }
    // A hidden fixed trim made the Deck meters move before the Qu channel
    // while leaving the post-fader LR bus almost inaudible. Gain is controlled
    // explicitly by the Deck/master controls and the Qu-16 surface instead.
    0.0
}

fn validate_deck(deck: u8) -> Result<(), String> {
    if matches!(deck, 1 | 2) {
        Ok(())
    } else {
        Err(format!("无效 Deck 编号：{deck}"))
    }
}

fn rescue_preview_instance_id(deck: u8) -> Result<u8, String> {
    validate_deck(deck)?;
    Ok(deck + RESCUE_PREVIEW_INSTANCE_OFFSET)
}

fn validate_instance(instance: u8) -> Result<(), String> {
    if matches!(instance, 1 | 2 | 11 | 12) {
        Ok(())
    } else {
        Err(format!("无效 mpv 实例编号：{instance}"))
    }
}

fn pipe_path(deck: u8) -> String {
    format!(r"\\.\pipe\king-club-mpv-{}-{deck}", std::process::id())
}

fn open_pipe(path: &str) -> std::io::Result<File> {
    OpenOptions::new().read(true).write(true).open(path)
}

fn open_pipe_with_timeout(path: &str, timeout: Duration) -> std::io::Result<File> {
    let started_at = Instant::now();
    loop {
        match open_pipe(path) {
            Ok(pipe) => return Ok(pipe),
            Err(_) if started_at.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            Err(error) => return Err(error),
        }
    }
}

fn wait_for_pipe(path: &str, child: &mut Child) -> Result<(), String> {
    let started_at = Instant::now();
    loop {
        if open_pipe(path).is_ok() {
            return Ok(());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!("mpv 启动后立即退出：{status}"));
        }
        if started_at.elapsed() >= MPV_START_TIMEOUT {
            return Err("等待 mpv JSON IPC 超时".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn spawn_deck(
    binary: &Path,
    deck: u8,
    process_job: &ProcessJob,
    audio_device: Option<&MpvAudioDevice>,
    output_trim_db: f64,
) -> Result<MpvInstance, String> {
    let pipe_path = pipe_path(deck);
    let mut command = Command::new(binary);
    command
        .args([
            "--idle=yes",
            "--no-terminal",
            "--no-config",
            "--load-scripts=no",
            "--video=no",
            "--audio-display=no",
            "--keep-open=yes",
            "--pause=yes",
            "--audio-client-name=KING CLUB Broadcast Control",
            "--input-default-bindings=no",
            "--input-vo-keyboard=no",
            &format!("--input-ipc-server={pipe_path}"),
        ])
        .args(MPV_AUDIO_OUTPUT_ARGS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(audio_device) = audio_device {
        command.arg(format!("--audio-device={}", audio_device.id));
    }
    if output_trim_db < 0.0 {
        command.arg(format!("--af=volume={output_trim_db:.1}dB"));
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 mpv：{error}"))?;
    if let Err(error) = process_job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    if let Err(error) = wait_for_pipe(&pipe_path, &mut child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(MpvInstance {
        child,
        pipe_path,
        loaded_path: None,
    })
}

fn send_command(pipe_path: &str, command: Value) -> Result<Value, String> {
    let mut pipe = open_pipe_with_timeout(pipe_path, Duration::from_secs(2))
        .map_err(|error| format!("无法连接 mpv IPC：{error}"))?;
    let request_id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let request = json!({ "command": command, "request_id": request_id });
    serde_json::to_writer(&mut pipe, &request).map_err(|error| error.to_string())?;
    pipe.write_all(b"\n").map_err(|error| error.to_string())?;
    pipe.flush().map_err(|error| error.to_string())?;

    let mut reader = BufReader::new(pipe);
    loop {
        let mut response_line = String::new();
        let bytes_read = reader
            .read_line(&mut response_line)
            .map_err(|error| format!("读取 mpv IPC 响应失败：{error}"))?;
        if bytes_read == 0 {
            return Err("mpv IPC 在返回命令结果前断开".to_string());
        }
        let response: Value = serde_json::from_str(&response_line)
            .map_err(|error| format!("mpv IPC 返回了无效 JSON：{error}"))?;
        if response.get("request_id").and_then(Value::as_u64) != Some(request_id) {
            // loadfile and seek can emit start-file/file-loaded/property-change events
            // before the command result. Events are not failures and must be skipped.
            continue;
        }
        if response.get("error").and_then(Value::as_str) != Some("success") {
            return Err(format!(
                "mpv 命令失败：{}",
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            ));
        }
        return Ok(response.get("data").cloned().unwrap_or(Value::Null));
    }
}

fn ensure_instance(
    manager: &mut MpvManagerInner,
    instance_id: u8,
) -> Result<&mut MpvInstance, String> {
    validate_instance(instance_id)?;
    let should_restart = match manager.instances.get_mut(&instance_id) {
        Some(instance) => instance
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some(),
        None => true,
    };
    if should_restart {
        manager.instances.remove(&instance_id);
        let binary = manager
            .binary
            .clone()
            .or_else(discover_mpv_binary)
            .ok_or_else(|| "未找到 mpv。请运行 npm run setup:mpv。".to_string())?;
        manager.binary = Some(binary.clone());
        if manager.audio_device.is_none() {
            manager.audio_device = discover_preferred_audio_device(&binary);
            manager.output_trim_db = preferred_output_trim_db(manager.audio_device.as_ref());
        }
        let instance = spawn_deck(
            &binary,
            instance_id,
            &manager.process_job,
            manager.audio_device.as_ref(),
            manager.output_trim_db,
        )?;
        manager.instances.insert(instance_id, instance);
    }
    manager
        .instances
        .get_mut(&instance_id)
        .ok_or_else(|| format!("mpv 实例 {instance_id} 未就绪"))
}

pub fn runtime_status(manager: &MpvManager) -> Result<MpvRuntimeStatus, String> {
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    if manager.binary.is_none() {
        manager.binary = discover_mpv_binary();
        manager.audio_device = manager
            .binary
            .as_deref()
            .and_then(discover_preferred_audio_device);
        manager.output_trim_db = preferred_output_trim_db(manager.audio_device.as_ref());
    }
    let binary = manager.binary.clone();
    let mut active_decks = Vec::new();
    manager.instances.retain(|deck, instance| {
        let running = instance.child.try_wait().ok().flatten().is_none();
        if running && matches!(*deck, 1 | 2) {
            active_decks.push(*deck);
        }
        running
    });
    active_decks.sort_unstable();
    let version = binary.as_deref().and_then(mpv_version);
    Ok(MpvRuntimeStatus {
        available: binary.is_some() && version.is_some(),
        binary_path: binary
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        version,
        audio_device: manager
            .audio_device
            .as_ref()
            .map(|device| device.id.clone()),
        audio_device_label: manager
            .audio_device
            .as_ref()
            .map(|device| device.label.clone()),
        output_trim_db: manager.output_trim_db,
        active_decks,
        message: if binary.is_some() {
            manager.audio_device.as_ref().map_or_else(
                || "mpv 播放引擎可用 · 系统自动音频设备".to_string(),
                |device| {
                    let route = if device
                        .label
                        .eq_ignore_ascii_case(KINGCLUB_ANALOG_AUDIO_DEVICE_LABEL)
                    {
                        "CH11/CH12 模拟输出"
                    } else {
                        "人工指定输出"
                    };
                    format!(
                        "mpv 播放引擎可用 · {route} → {} · 输出修整 {:.0} dB",
                        device.label, manager.output_trim_db
                    )
                },
            )
        } else {
            "未找到 mpv；当前使用 WebView2 回退播放".to_string()
        },
    })
}

pub fn load_deck(manager: &MpvManager, deck: u8, path: &Path) -> Result<MpvDeckState, String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("媒体文件不存在：{error}"))?;
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    let instance = ensure_instance(&mut manager, deck)?;
    send_command(
        &instance.pipe_path,
        json!(["loadfile", canonical_path.to_string_lossy(), "replace"]),
    )?;
    send_command(&instance.pipe_path, json!(["set_property", "pause", true]))?;
    instance.loaded_path = Some(canonical_path);
    deck_state_for_instance(deck, instance)
}

pub fn switch_source_preserving_state(
    manager: &MpvManager,
    deck: u8,
    path: &Path,
) -> Result<MpvDeckState, String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("媒体文件不存在：{error}"))?;
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    let instance = ensure_instance(&mut manager, deck)?;
    let previous = deck_state_for_instance(deck, instance)?;
    send_command(
        &instance.pipe_path,
        json!(["loadfile", canonical_path.to_string_lossy(), "replace"]),
    )?;
    send_command(&instance.pipe_path, json!(["set_property", "pause", true]))?;
    instance.loaded_path = Some(canonical_path);

    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut duration = 0.0;
    while std::time::Instant::now() < deadline {
        duration = property_f64(&instance.pipe_path, "duration");
        if duration > 0.0 {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    if previous.time_pos > 0.0 {
        let target = if duration > 0.0 {
            previous.time_pos.min(duration)
        } else {
            previous.time_pos
        };
        send_command(
            &instance.pipe_path,
            json!(["seek", target, "absolute+exact"]),
        )?;
    }
    send_command(
        &instance.pipe_path,
        json!(["set_property", "volume", previous.volume.clamp(0.0, 100.0)]),
    )?;
    send_command(
        &instance.pipe_path,
        json!(["set_property", "pause", previous.paused]),
    )?;
    deck_state_for_instance(deck, instance)
}

pub fn set_paused(manager: &MpvManager, deck: u8, paused: bool) -> Result<MpvDeckState, String> {
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    let instance = ensure_instance(&mut manager, deck)?;
    send_command(
        &instance.pipe_path,
        json!(["set_property", "pause", paused]),
    )?;
    deck_state_for_instance(deck, instance)
}

pub fn seek(manager: &MpvManager, deck: u8, seconds: f64) -> Result<MpvDeckState, String> {
    if !seconds.is_finite() {
        return Err("Seek 时间必须是有限数字".to_string());
    }
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    let instance = ensure_instance(&mut manager, deck)?;
    let previous = deck_state_for_instance(deck, instance)?;
    safe_seek_instance(
        instance,
        seconds,
        !previous.paused,
        previous.volume.clamp(0.0, 100.0),
    )?;
    deck_state_for_instance(deck, instance)
}

pub fn set_volume(manager: &MpvManager, deck: u8, volume: f64) -> Result<MpvDeckState, String> {
    if !volume.is_finite() {
        return Err("音量必须是有限数字".to_string());
    }
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    let instance = ensure_instance(&mut manager, deck)?;
    send_command(
        &instance.pipe_path,
        json!(["set_property", "volume", volume.clamp(0.0, 100.0)]),
    )?;
    deck_state_for_instance(deck, instance)
}

pub fn deck_state(manager: &MpvManager, deck: u8) -> Result<MpvDeckState, String> {
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    let instance = ensure_instance(&mut manager, deck)?;
    deck_state_for_instance(deck, instance)
}

fn property(pipe_path: &str, name: &str) -> Result<Value, String> {
    send_command(pipe_path, json!(["get_property", name]))
}

fn property_f64(pipe_path: &str, name: &str) -> f64 {
    property(pipe_path, name)
        .ok()
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
}

fn safe_seek_instance(
    instance: &mut MpvInstance,
    seconds: f64,
    resume_playing: bool,
    final_volume: f64,
) -> Result<(), String> {
    let duration = property_f64(&instance.pipe_path, "duration");
    let target = if duration.is_finite() && duration > 0.0 {
        seconds.max(0.0).min(duration)
    } else {
        seconds.max(0.0)
    };
    let safe_volume = final_volume.clamp(0.0, 100.0);

    // Qu-16 USB/WASAPI endpoints can emit a loud invalid-buffer burst when an
    // exact seek flushes the decoder while the endpoint is still playing.
    // Keep that transition away from the physical output and fail closed.
    send_command(&instance.pipe_path, json!(["set_property", "volume", 0.0]))?;
    send_command(&instance.pipe_path, json!(["set_property", "pause", true]))?;
    send_command(
        &instance.pipe_path,
        json!(["seek", target, "absolute+exact"]),
    )?;

    let settle_deadline = Instant::now() + MPV_SEEK_SETTLE_TIMEOUT;
    let mut stable_reads = 0_u8;
    while Instant::now() < settle_deadline {
        let seeking = property(&instance.pipe_path, "seeking")
            .ok()
            .and_then(|value| value.as_bool());
        let position = property(&instance.pipe_path, "time-pos")
            .ok()
            .and_then(|value| value.as_f64());
        let stable = seeking == Some(false)
            && position.is_some_and(|value| {
                value.is_finite() && (value - target).abs() <= MPV_SEEK_POSITION_TOLERANCE_SECONDS
            });
        stable_reads = if stable {
            stable_reads.saturating_add(1)
        } else {
            0
        };
        if stable_reads >= MPV_SEEK_STABLE_READS {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    if stable_reads < MPV_SEEK_STABLE_READS {
        return Err("mpv Seek 未在安全窗口内稳定；Deck 已保持静音暂停".into());
    }

    if resume_playing {
        send_command(&instance.pipe_path, json!(["set_property", "pause", false]))?;
        for step in 1..=MPV_SEEK_FADE_STEPS {
            thread::sleep(MPV_SEEK_FADE_STEP_DELAY);
            let volume = safe_volume * f64::from(step) / f64::from(MPV_SEEK_FADE_STEPS);
            send_command(
                &instance.pipe_path,
                json!(["set_property", "volume", volume]),
            )?;
        }
    } else {
        send_command(
            &instance.pipe_path,
            json!(["set_property", "volume", safe_volume]),
        )?;
    }
    Ok(())
}

fn deck_state_for_instance(deck: u8, instance: &mut MpvInstance) -> Result<MpvDeckState, String> {
    if instance
        .child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err(format!("Deck {deck} mpv 实例已经退出"));
    }
    Ok(MpvDeckState {
        deck,
        running: true,
        path: instance
            .loaded_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        paused: property(&instance.pipe_path, "pause")
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
        time_pos: property_f64(&instance.pipe_path, "time-pos"),
        duration: property_f64(&instance.pipe_path, "duration"),
        volume: property_f64(&instance.pipe_path, "volume"),
        eof_reached: property(&instance.pipe_path, "eof-reached")
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    })
}

pub fn shutdown_deck(manager: &MpvManager, deck: u8) -> Result<(), String> {
    validate_deck(deck)?;
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    if let Some(mut instance) = manager.instances.remove(&deck) {
        let _ = send_command(&instance.pipe_path, json!(["quit"]));
        if instance.child.try_wait().ok().flatten().is_none() {
            let _ = instance.child.kill();
        }
        let _ = instance.child.wait();
    }
    Ok(())
}

pub fn shutdown_all(manager: &MpvManager) -> Result<(), String> {
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    let instances = std::mem::take(&mut manager.instances);
    for (_, mut instance) in instances {
        let _ = send_command(&instance.pipe_path, json!(["quit"]));
        if instance.child.try_wait().ok().flatten().is_none() {
            let _ = instance.child.kill();
        }
        let _ = instance.child.wait();
    }
    Ok(())
}

pub fn sync_rescue_preview(
    manager: &MpvManager,
    deck: u8,
    path: &Path,
    seconds: f64,
    playing: bool,
    enabled: bool,
    volume: f64,
) -> Result<MpvRescuePreviewState, String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("补音试听时间必须是非负有限数字".into());
    }
    if !volume.is_finite() {
        return Err("补音试听音量必须是有限数字".into());
    }
    let instance_id = rescue_preview_instance_id(deck)?;
    let mut manager = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 mpv 状态".to_string())?;
    if !enabled {
        if let Some(mut instance) = manager.instances.remove(&instance_id) {
            let _ = send_command(&instance.pipe_path, json!(["quit"]));
            if instance.child.try_wait().ok().flatten().is_none() {
                let _ = instance.child.kill();
            }
            let _ = instance.child.wait();
        }
        return Ok(MpvRescuePreviewState {
            deck,
            running: false,
            path: None,
            paused: true,
            time_pos: seconds,
            volume: 0.0,
            software_preview: false,
            physical_audio_started: false,
            message: format!("Deck {deck} 本地补音试听已关闭"),
        });
    }

    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("补音参考轨不存在：{error}"))?;
    let instance = ensure_instance(&mut manager, instance_id)?;
    let changed_path = instance.loaded_path.as_ref() != Some(&canonical_path);
    if changed_path {
        send_command(
            &instance.pipe_path,
            json!(["loadfile", canonical_path.to_string_lossy(), "replace"]),
        )?;
        send_command(&instance.pipe_path, json!(["set_property", "pause", true]))?;
        instance.loaded_path = Some(canonical_path.clone());
    }
    let safe_volume = volume.clamp(0.0, 100.0);
    let current_seconds = property_f64(&instance.pipe_path, "time-pos");
    if changed_path || (current_seconds - seconds).abs() > RESCUE_PREVIEW_DRIFT_SECONDS {
        safe_seek_instance(instance, seconds, playing, safe_volume)?;
    } else {
        send_command(
            &instance.pipe_path,
            json!(["set_property", "volume", safe_volume]),
        )?;
        send_command(
            &instance.pipe_path,
            json!(["set_property", "pause", !playing]),
        )?;
    }
    Ok(MpvRescuePreviewState {
        deck,
        running: true,
        path: Some(canonical_path.to_string_lossy().into_owned()),
        paused: !playing,
        time_pos: property_f64(&instance.pipe_path, "time-pos"),
        volume: property_f64(&instance.pipe_path, "volume"),
        software_preview: true,
        physical_audio_started: false,
        message: if playing {
            format!("Deck {deck} 本地补音试听中")
        } else {
            format!("Deck {deck} 本地补音试听已跟随暂停")
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_two_decks_are_valid() {
        assert!(validate_deck(1).is_ok());
        assert!(validate_deck(2).is_ok());
        assert!(validate_deck(0).is_err());
        assert!(validate_deck(3).is_err());
    }

    #[test]
    fn rescue_preview_uses_private_instances_without_widening_deck_ids() {
        assert_eq!(rescue_preview_instance_id(1).unwrap(), 11);
        assert_eq!(rescue_preview_instance_id(2).unwrap(), 12);
        assert!(rescue_preview_instance_id(3).is_err());
        assert!(validate_deck(11).is_err());
        assert!(validate_instance(11).is_ok());
        assert!(validate_instance(12).is_ok());
    }

    #[test]
    fn shutdown_all_is_safe_when_no_deck_is_running() {
        let manager = MpvManager::default();
        shutdown_all(&manager).expect("empty mpv manager should shut down cleanly");
        assert!(manager.0.lock().unwrap().instances.is_empty());
    }

    #[test]
    fn local_mpv_candidate_is_discoverable_when_provisioned() {
        let candidates = executable_candidates();
        assert!(candidates
            .iter()
            .any(|path| path.ends_with(Path::new(".local-tools/mpv/mpv.exe"))));
    }

    #[test]
    fn parses_mpv_audio_devices_and_keeps_stable_wasapi_id() {
        let devices = parse_audio_devices(
            "List of detected audio devices:\n  'auto' (Autoselect device)\n  'wasapi/{f51955ae-1997-4ebd-bb2d-84ac01bed4e2}' (Qu-16 ST3 (Qu-16))\n",
        );
        assert_eq!(devices.len(), 2);
        assert_eq!(
            devices[1].id,
            "wasapi/{f51955ae-1997-4ebd-bb2d-84ac01bed4e2}"
        );
        assert_eq!(devices[1].label, "Qu-16 ST3 (Qu-16)");
    }

    #[test]
    fn onsite_default_selects_realtek_analog_and_never_falls_back_to_qu16_usb() {
        let devices = parse_audio_devices(
            "List of detected audio devices:\n  'auto' (Autoselect device)\n  'wasapi/realtek' (扬声器 (Realtek(R) Audio))\n  'wasapi/qu16' (Qu-16 ST3 (Qu-16))\n",
        );
        assert_eq!(
            select_preferred_audio_device(&devices, None)
                .as_ref()
                .map(|device| device.id.as_str()),
            Some("wasapi/realtek")
        );
        assert_eq!(
            select_preferred_audio_device(&devices, Some("wasapi/qu16"))
                .as_ref()
                .map(|device| device.id.as_str()),
            Some("wasapi/qu16")
        );
        assert!(select_preferred_audio_device(&devices, Some("auto")).is_none());

        let usb_only = vec![devices[2].clone()];
        assert!(select_preferred_audio_device(&usb_only, None).is_none());
    }

    #[test]
    fn qu16_uses_unity_output_trim_by_default() {
        let device = MpvAudioDevice {
            id: "wasapi/test".into(),
            label: "Qu-16 ST3 (Qu-16)".into(),
        };
        assert_eq!(preferred_output_trim_db(Some(&device)), 0.0);
        assert_eq!(preferred_output_trim_db(None), 0.0);
    }

    #[test]
    fn deck_audio_output_is_fixed_to_stable_shared_mode() {
        assert!(MPV_AUDIO_OUTPUT_ARGS.contains(&"--ao=wasapi"));
        assert!(MPV_AUDIO_OUTPUT_ARGS.contains(&"--audio-exclusive=no"));
        assert!(MPV_AUDIO_OUTPUT_ARGS.contains(&"--audio-samplerate=48000"));
        assert!(MPV_AUDIO_OUTPUT_ARGS.contains(&"--audio-channels=stereo"));
        assert!(MPV_AUDIO_OUTPUT_ARGS.contains(&"--gapless-audio=weak"));
        assert!(MPV_AUDIO_OUTPUT_ARGS.contains(&"--audio-buffer=0.5"));
        assert!(!MPV_AUDIO_OUTPUT_ARGS.contains(&"--gapless-audio=yes"));
    }

    #[test]
    fn real_mpv_loads_plays_seeks_and_reports_audio_state_when_fixture_is_available() {
        let audio_path = env::var_os("KING_MEDIA_FIXTURE")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("KING_MEDIA_FIXTURE_DIR")
                    .map(PathBuf::from)
                    .map(|directory| directory.join("t-rex-roar.mp3"))
            });
        let Some(audio_path) = audio_path else {
            return;
        };
        assert!(audio_path.is_file(), "missing real MP3 fixture");

        let manager = MpvManager::default();
        let runtime = runtime_status(&manager).expect("read mpv runtime status");
        assert!(runtime.available, "{}", runtime.message);

        let loaded = load_deck(&manager, 1, &audio_path).expect("load real MP3 into Deck 1");
        assert!(loaded.running);
        assert!(loaded.paused);
        set_volume(&manager, 1, 0.0).expect("mute test Deck");
        set_paused(&manager, 1, false).expect("start real mpv playback");
        thread::sleep(Duration::from_millis(350));
        let playing = deck_state(&manager, 1).expect("query live mpv Deck state");
        assert!(!playing.paused);
        assert!(playing.duration > 0.0);
        assert!(playing.time_pos > 0.0);

        let sought = seek(&manager, 1, 0.1).expect("seek real mpv playback");
        assert!(sought.time_pos >= 0.0);
        set_paused(&manager, 1, true).expect("pause real mpv playback");
        let reloaded = load_deck(&manager, 1, &audio_path)
            .expect("replace an already loaded Deck while mpv emits file events");
        assert!(reloaded.paused);
        assert_eq!(
            reloaded.path.as_deref().map(Path::new),
            Some(audio_path.canonicalize().unwrap().as_path())
        );
        thread::sleep(Duration::from_millis(150));
        seek(&manager, 1, 1.0).expect("position Deck before source switch");
        set_volume(&manager, 1, 37.0).expect("set Deck volume before source switch");
        let switch_path = env::var_os("KING_MEDIA_SWITCH_FIXTURE")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .unwrap_or_else(|| audio_path.clone());
        let switched = switch_source_preserving_state(&manager, 1, &switch_path)
            .expect("switch source while preserving Deck state");
        assert!(switched.paused);
        assert!((switched.volume - 37.0).abs() < 0.1);
        assert!(switched.time_pos >= 0.5);
        shutdown_deck(&manager, 1).expect("shutdown real mpv Deck");
    }
}
