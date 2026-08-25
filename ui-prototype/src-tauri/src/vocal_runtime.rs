use serde_json::{json, Value};
use std::{
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Mutex,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct VocalRuntimeBridge {
    state: Mutex<BridgeState>,
}

impl Default for VocalRuntimeBridge {
    fn default() -> Self {
        Self {
            state: Mutex::new(BridgeState::default()),
        }
    }
}

#[derive(Default)]
struct BridgeState {
    process: Option<VocalControlProcess>,
    next_request_id: u64,
}

struct VocalControlProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for VocalControlProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl VocalRuntimeBridge {
    pub fn status(&self) -> Result<Value, String> {
        self.request(json!({"command": "status"}))
    }

    pub fn set_preset(&self, lane: &str, preset: &str) -> Result<Value, String> {
        self.request(json!({
            "command": "set_preset",
            "lane": lane,
            "preset": preset,
        }))
    }

    pub fn evaluate_arm(&self, request: Value) -> Result<Value, String> {
        self.request(json!({
            "command": "evaluate_arm",
            "request": request,
        }))
    }

    pub fn disarm(&self) -> Result<Value, String> {
        self.request(json!({"command": "disarm"}))
    }

    fn request(&self, mut payload: Value) -> Result<Value, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
        let request_id = state.next_request_id;
        payload["id"] = json!(request_id);

        for attempt in 0..2 {
            if state.process.is_none() {
                state.process = Some(VocalControlProcess::spawn()?);
            }
            let result = state
                .process
                .as_mut()
                .ok_or_else(|| "Vocal Engine 控制进程未启动".to_string())?
                .exchange(&payload, request_id);
            match result {
                Ok(response) => return Ok(response),
                Err(error) if attempt == 0 => {
                    state.process = None;
                    log::warn!("Vocal Engine 控制桥重启：{error}");
                }
                Err(error) => return Err(error),
            }
        }
        Err("Vocal Engine 控制桥请求失败".into())
    }
}

impl VocalControlProcess {
    fn spawn() -> Result<Self, String> {
        let executable = resolve_vocal_engine_executable()?;
        let mut command = Command::new(&executable);
        command
            .arg("control-stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 {}：{error}", executable.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Vocal Engine stdin 不可用".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Vocal Engine stdout 不可用".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn exchange(&mut self, payload: &Value, request_id: u64) -> Result<Value, String> {
        serde_json::to_writer(&mut self.stdin, payload)
            .map_err(|error| format!("Vocal Engine 请求编码失败：{error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("Vocal Engine 请求写入失败：{error}"))?;
        let mut line = String::new();
        let read = self
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("Vocal Engine 响应读取失败：{error}"))?;
        if read == 0 {
            return Err("Vocal Engine 控制进程已退出".into());
        }
        let response: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Vocal Engine 响应无效：{error}"))?;
        if response.get("id").and_then(Value::as_u64) != Some(request_id) {
            return Err("Vocal Engine 响应序号不匹配".into());
        }
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Vocal Engine 请求被拒绝")
                .to_string());
        }
        Ok(response)
    }
}

pub(crate) fn resolve_vocal_engine_executable() -> Result<PathBuf, String> {
    let file_name = if cfg!(windows) {
        "king-vocal-engine.exe"
    } else {
        "king-vocal-engine"
    };
    let mut candidates = Vec::new();
    if let Some(configured) = env::var_os("KING_VOCAL_ENGINE_PATH") {
        candidates.push(PathBuf::from(configured));
    }
    if let Ok(current) = env::current_exe() {
        if let Some(parent) = current.parent() {
            candidates.push(parent.join(file_name));
        }
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("vocal-engine")
            .join("target")
            .join("release")
            .join(file_name),
    );
    candidates
        .into_iter()
        .find(|candidate| {
            fs::metadata(candidate)
                .map(|meta| meta.is_file())
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            "找不到 king-vocal-engine；请先完成 Release 构建或配置 KING_VOCAL_ENGINE_PATH".into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_binary_candidate_is_repo_relative() {
        let path = resolve_vocal_engine_executable().expect("release engine should exist for P14");
        assert!(path.ends_with(if cfg!(windows) {
            "king-vocal-engine.exe"
        } else {
            "king-vocal-engine"
        }));
    }
}
