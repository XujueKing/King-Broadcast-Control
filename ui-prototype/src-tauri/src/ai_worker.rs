use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct WorkerProcess {
    child: Option<Child>,
    python_path: Option<PathBuf>,
    worker_path: Option<PathBuf>,
    message: String,
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
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
    pub running: bool,
    pub process_id: Option<u32>,
    pub python_path: Option<String>,
    pub worker_path: Option<String>,
    pub message: String,
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

pub fn start(app: &AppHandle, manager: &AiWorkerManager) -> Result<AiWorkerStatus, String> {
    let mut state = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 AI worker 状态".to_string())?;
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
    let log_directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&log_directory).map_err(|error| error.to_string())?;
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
    state.python_path = Some(python);
    state.worker_path = Some(worker);
    state.message = "AI 后台分析已启动（低优先级、单任务）".to_string();
    state.child = Some(child);
    status_locked(&mut state)
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
    Ok(AiWorkerStatus {
        available: state
            .python_path
            .as_ref()
            .is_some_and(|path| path.is_file())
            && state
                .worker_path
                .as_ref()
                .is_some_and(|path| path.is_file()),
        running,
        process_id: state.child.as_ref().map(Child::id),
        python_path: state
            .python_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        worker_path: state
            .worker_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        message: state.message.clone(),
    })
}

pub fn status(manager: &AiWorkerManager) -> Result<AiWorkerStatus, String> {
    let mut state = manager
        .0
        .lock()
        .map_err(|_| "无法锁定 AI worker 状态".to_string())?;
    if state.python_path.is_none() || state.worker_path.is_none() {
        if let Some((python, worker)) = discover_runtime() {
            state.python_path = Some(python);
            state.worker_path = Some(worker);
        }
    }
    status_locked(&mut state)
}
