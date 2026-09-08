use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::{io::AsRawHandle, process::CommandExt};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child) {
    let _ = Command::new("taskkill.exe")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(windows)]
fn create_worker_job() -> Option<isize> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            let _ = CloseHandle(job);
            None
        } else {
            Some(job as isize)
        }
    }
}

#[cfg(windows)]
fn assign_to_worker_job(job_handle: Option<isize>, child: &Child) -> bool {
    let Some(job_handle) = job_handle else {
        return false;
    };
    unsafe { AssignProcessToJobObject(job_handle as _, child.as_raw_handle() as _) != 0 }
}

struct WorkerProcess {
    child: Option<Child>,
    moss_child: Option<Child>,
    #[cfg(windows)]
    job_handle: Option<isize>,
    moss_started_by_app: bool,
    python_path: Option<PathBuf>,
    worker_path: Option<PathBuf>,
    message: String,
    playing_jobs: usize,
    deck_jobs: usize,
    runtime_enabled: bool,
    runtime_preference_loaded: bool,
}

impl Default for WorkerProcess {
    fn default() -> Self {
        Self {
            child: None,
            moss_child: None,
            #[cfg(windows)]
            job_handle: None,
            moss_started_by_app: false,
            python_path: None,
            worker_path: None,
            message: String::new(),
            playing_jobs: 0,
            deck_jobs: 0,
            runtime_enabled: true,
            runtime_preference_loaded: false,
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(job_handle) = self.job_handle.take() {
            unsafe {
                let _ = CloseHandle(job_handle as _);
            }
        }
        if let Some(child) = self.child.as_mut() {
            terminate_process_tree(child);
            let _ = child.wait();
        }
        if let Some(child) = self.moss_child.as_mut() {
            terminate_process_tree(child);
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
pub struct AiWorkerManager(Mutex<WorkerProcess>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkerStatus {
    pub available: bool,
    pub enabled: bool,
    pub running: bool,
    pub playback_protected: bool,
    pub process_id: Option<u32>,
    pub python_path: Option<String>,
    pub worker_path: Option<String>,
    pub moss_service_managed: bool,
    pub moss_process_id: Option<u32>,
    pub scheduler_tier: String,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiRuntimeSettings {
    enabled: bool,
}

fn runtime_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("runtime")
        .join("ai-production.json"))
}

fn load_runtime_preference(app: &AppHandle, state: &mut WorkerProcess) -> Result<(), String> {
    if state.runtime_preference_loaded {
        return Ok(());
    }
    let path = runtime_settings_path(app)?;
    state.runtime_enabled = if path.is_file() {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        serde_json::from_slice::<AiRuntimeSettings>(&bytes)
            .map_err(|error| format!("AI 制作开关配置损坏：{error}"))?
            .enabled
    } else {
        true
    };
    state.runtime_preference_loaded = true;
    Ok(())
}

fn save_runtime_preference(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let path = runtime_settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&AiRuntimeSettings { enabled })
        .map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn stop_locked(state: &mut WorkerProcess) {
    if let Some(mut child) = state.child.take() {
        terminate_process_tree(&mut child);
        let _ = child.wait();
    }
    if let Some(mut child) = state.moss_child.take() {
        terminate_process_tree(&mut child);
        let _ = child.wait();
    }
    state.moss_started_by_app = false;
}

fn scheduler_tier(state: &WorkerProcess) -> &'static str {
    if state.playing_jobs > 0 {
        "on-air"
    } else if state.deck_jobs > 0 {
        "deck-ready"
    } else {
        "background"
    }
}

fn scheduler_message(state: &WorkerProcess) -> String {
    match scheduler_tier(state) {
        "on-air" => "播放保护：检测到 Deck 正在播出，AI 制作已暂停；停止播放后自动继续".to_string(),
        "deck-ready" => "AI 三级调度：Deck 待播歌曲优先；后台曲库随后".to_string(),
        _ => "AI 三级调度：曲库后台制作（低优先级、单任务）".to_string(),
    }
}

fn development_project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn discover_runtime() -> Option<(PathBuf, PathBuf)> {
    let root = development_project_root();
    let python = root.join(".venv-audio-ai/Scripts/python.exe");
    let worker = root.join("ai-worker/worker.py");
    (python.is_file() && worker.is_file()).then_some((python, worker))
}

fn moss_port_is_open() -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], 30_000)),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn start_moss_if_needed(root: &Path, log_directory: &Path) -> Result<Option<Child>, String> {
    if moss_port_is_open() {
        return Ok(None);
    }
    let script = root.join("scripts/start-moss-music.ps1");
    if !script.is_file() {
        return Err("未找到 MOSS-Music 启动脚本".to_string());
    }
    let stdout = fs::File::create(log_directory.join("moss-music.log"))
        .map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    command.creation_flags(IDLE_PRIORITY_CLASS | CREATE_NO_WINDOW);
    command.spawn().map(Some).map_err(|error| error.to_string())
}

pub fn start(app: &AppHandle, manager: &AiWorkerManager) -> Result<AiWorkerStatus, String> {
    let mut state = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 AI worker 状态".to_string())?;
    load_runtime_preference(app, &mut state)?;
    if !state.runtime_enabled {
        stop_locked(&mut state);
        state.message = "开业模式：AI 歌曲制作已关闭，MOSS 与 Worker 均未运行".to_string();
        return status_locked(&mut state);
    }
    if state.playing_jobs > 0 {
        // Windows process priority does not throttle CUDA scheduling. Stem
        // separation can therefore saturate the GPU while mpv is feeding the
        // venue output, producing audible underruns. Release the entire AI
        // process tree and GPU allocation while either Deck is on air.
        stop_locked(&mut state);
        state.message = scheduler_message(&state);
        return status_locked(&mut state);
    }
    #[cfg(windows)]
    if state.job_handle.is_none() {
        state.job_handle = create_worker_job();
    }
    let log_directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&log_directory).map_err(|error| error.to_string())?;
    if let Some(child) = state.moss_child.as_mut() {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            state.moss_child = None;
        }
    }
    if state.moss_child.is_none() && !moss_port_is_open() {
        state.moss_child = start_moss_if_needed(&development_project_root(), &log_directory)?;
        #[cfg(windows)]
        if let Some(child) = state.moss_child.as_ref() {
            let _ = assign_to_worker_job(state.job_handle, child);
        }
        state.moss_started_by_app = state.moss_child.is_some();
    }
    if let Some(child) = state.child.as_mut() {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return status_locked(&mut state);
        }
        state.child = None;
    }
    let Some((python, worker)) = discover_runtime() else {
        state.message = "未找到项目 AI 环境，请运行 npm run setup:audio-ai".to_string();
        return status_locked(&mut state);
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let database = app_data.join("king-club.sqlite3");
    let stdout = fs::File::create(log_directory.join("audio-ai-worker.log"))
        .map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(&python);
    command
        .arg(&worker)
        .arg("--run")
        .arg("--database")
        .arg(database)
        .current_dir(development_project_root())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    command.creation_flags(IDLE_PRIORITY_CLASS | CREATE_NO_WINDOW);
    let child = command.spawn().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let _ = assign_to_worker_job(state.job_handle, &child);
    state.python_path = Some(python);
    state.worker_path = Some(worker);
    state.message = if moss_port_is_open() {
        scheduler_message(&state)
    } else {
        "AI 三级调度已启动，正在等待 MOSS-Music 加载".to_string()
    };
    state.child = Some(child);
    status_locked(&mut state)
}

pub fn set_scheduler_context(
    manager: &AiWorkerManager,
    playing_jobs: usize,
    deck_jobs: usize,
) -> Result<(), String> {
    let mut state = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 AI worker 状态".to_string())?;
    state.playing_jobs = playing_jobs;
    state.deck_jobs = deck_jobs;
    if state.runtime_enabled && state.playing_jobs > 0 {
        stop_locked(&mut state);
    }
    state.message = if state.runtime_enabled {
        scheduler_message(&state)
    } else {
        "开业模式：AI 歌曲制作已关闭，MOSS 与 Worker 均未运行".to_string()
    };
    Ok(())
}

pub fn set_runtime_enabled(
    app: &AppHandle,
    manager: &AiWorkerManager,
    enabled: bool,
) -> Result<AiWorkerStatus, String> {
    {
        let mut state = manager
            .0
            .lock()
            .map_err(|_| "无法锁定 AI worker 状态".to_string())?;
        load_runtime_preference(app, &mut state)?;
        save_runtime_preference(app, enabled)?;
        state.runtime_enabled = enabled;
        state.runtime_preference_loaded = true;
        if !enabled {
            stop_locked(&mut state);
            state.message = "开业模式：AI 歌曲制作已关闭，MOSS 与 Worker 均未运行".to_string();
            return status_locked(&mut state);
        }
    }
    start(app, manager)
}

fn status_locked(state: &mut WorkerProcess) -> Result<AiWorkerStatus, String> {
    let running = match state.child.as_mut() {
        Some(child) => child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none(),
        None => false,
    };
    if !running {
        state.child = None;
    }
    if let Some(child) = state.moss_child.as_mut() {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            state.moss_child = None;
        }
    }
    Ok(AiWorkerStatus {
        available: state
            .python_path
            .as_ref()
            .is_some_and(|path| path.is_file())
            && state
                .worker_path
                .as_ref()
                .is_some_and(|path| path.is_file()),
        enabled: state.runtime_enabled,
        running,
        playback_protected: state.runtime_enabled && state.playing_jobs > 0,
        process_id: state.child.as_ref().map(Child::id),
        python_path: state
            .python_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        worker_path: state
            .worker_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        moss_service_managed: state.moss_started_by_app,
        moss_process_id: state.moss_child.as_ref().map(Child::id),
        scheduler_tier: scheduler_tier(state).to_string(),
        message: state.message.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_air_scheduler_uses_playback_protection() {
        let mut state = WorkerProcess::default();
        state.runtime_enabled = true;
        state.playing_jobs = 1;
        state.deck_jobs = 2;

        assert_eq!(scheduler_tier(&state), "on-air");
        assert!(scheduler_message(&state).contains("AI 制作已暂停"));
        stop_locked(&mut state);
        let status = status_locked(&mut state).expect("status");
        assert!(status.enabled);
        assert!(status.playback_protected);
        assert!(!status.running);
    }

    #[test]
    fn idle_scheduler_is_not_playback_protected() {
        let mut state = WorkerProcess::default();
        state.runtime_enabled = true;
        state.playing_jobs = 0;
        state.deck_jobs = 1;

        let status = status_locked(&mut state).expect("status");
        assert!(!status.playback_protected);
        assert_eq!(scheduler_tier(&state), "deck-ready");
    }
}

pub fn status(app: &AppHandle, manager: &AiWorkerManager) -> Result<AiWorkerStatus, String> {
    let mut state = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 AI worker 状态".to_string())?;
    load_runtime_preference(app, &mut state)?;
    if state.python_path.is_none() || state.worker_path.is_none() {
        if let Some((python, worker)) = discover_runtime() {
            state.python_path = Some(python);
            state.worker_path = Some(worker);
        }
    }
    status_locked(&mut state)
}
