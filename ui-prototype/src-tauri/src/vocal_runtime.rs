use serde_json::{json, Value};
use std::{
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, SyncSender},
        Mutex,
    },
    time::Duration,
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

struct BridgeState {
    process: Option<VocalControlProcess>,
    live_process: Option<VocalLiveProcess>,
    next_request_id: u64,
    desired_playback: DesiredPlayback,
    desired_rescue_enabled: bool,
    desired_reference: Option<Value>,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            process: None,
            live_process: None,
            next_request_id: 0,
            desired_playback: DesiredPlayback::default(),
            desired_rescue_enabled: true,
            desired_reference: None,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct DesiredPlayback {
    deck: u8,
    seconds: f64,
    playing: bool,
}

struct VocalControlProcess {
    child: Child,
    requests: SyncSender<(Value, SyncSender<Result<Value, String>>)>,
}

struct VocalLiveProcess(VocalControlProcess);

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
        let live = self.stop_live()?;
        let control = self.request(json!({"command": "disarm"}))?;
        Ok(json!({"ok": true, "control": control, "live": live, "physicalAudioStarted": false}))
    }

    pub fn live_status(&self) -> Result<Value, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let desired = state.desired_playback;
        let desired_rescue_enabled = state.desired_rescue_enabled;
        let desired_reference = state.desired_reference.clone();
        let request_id = next_request_id(&mut state);
        let Some(process) = state.live_process.as_mut() else {
            return Ok(json!({
                "ok": true,
                "state": "disarmed",
                "physicalAudioStarted": false,
                "desiredPlayback": desired_playback_json(desired),
                "desiredRescueEnabled": desired_rescue_enabled,
                "desiredReference": desired_reference,
                "message": "现场输入/返回路由尚未武装；Deck 时钟已待命",
            }));
        };
        match process.exchange(&json!({"id": request_id, "command": "status"}), request_id) {
            Ok(mut response) => {
                response["desiredPlayback"] = desired_playback_json(desired);
                response["desiredRescueEnabled"] = json!(desired_rescue_enabled);
                response["desiredReference"] = desired_reference.unwrap_or(Value::Null);
                Ok(response)
            }
            Err(error) => {
                state.live_process = None;
                Err(format!("Vocal Engine 实时进程已退出：{error}"))
            }
        }
    }

    pub fn sync_playback(&self, deck: u8, seconds: f64, playing: bool) -> Result<Value, String> {
        if !matches!(deck, 1 | 2) || !seconds.is_finite() || seconds < 0.0 {
            return Err("Deck 时钟参数无效".into());
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.desired_playback = DesiredPlayback {
            deck,
            seconds,
            playing,
        };
        let request_id = next_request_id(&mut state);
        let Some(process) = state.live_process.as_mut() else {
            return Ok(json!({
                "ok": true,
                "state": "pending-route-verification",
                "physicalAudioStarted": false,
                "desiredPlayback": desired_playback_json(state.desired_playback),
            }));
        };
        process.exchange(
            &json!({"id": request_id, "command": "sync_playback", "seconds": seconds, "playing": playing}),
            request_id,
        )
    }

    pub fn set_rescue_enabled(&self, enabled: bool) -> Result<Value, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.desired_rescue_enabled = enabled;
        let request_id = next_request_id(&mut state);
        let Some(process) = state.live_process.as_mut() else {
            return Ok(json!({
                "ok": true,
                "state": "pending-route-verification",
                "physicalAudioStarted": false,
                "desiredRescueEnabled": enabled,
            }));
        };
        process.exchange(
            &json!({"id": request_id, "command": "set_rescue_enabled", "enabled": enabled}),
            request_id,
        )
    }

    pub fn bind_reference(&self, request: Value) -> Result<Value, String> {
        let profile_id = required_string(&request, "profileId")?;
        let display_name = required_string(&request, "displayName")?;
        let media_path = required_existing_file(&request, "mediaPath")?;
        let reference_path = required_existing_file(&request, "referencePath")?;
        let reference_vocal_path = required_existing_file(&request, "referenceVocalPath")?;
        let binding = json!({
            "profileId": profile_id,
            "displayName": display_name,
            "mediaPath": media_path,
            "referencePath": reference_path,
            "referenceVocalPath": reference_vocal_path,
        });
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.live_process.is_some() {
            return Err("请先停止实时补音链路，再切换歌手或歌曲参考轨".into());
        }
        state.desired_reference = Some(binding.clone());
        Ok(json!({
            "ok": true,
            "state": "reference-ready-route-not-armed",
            "physicalAudioStarted": false,
            "desiredReference": binding,
            "message": "补音参考已绑定；现场输入与返回路由尚未武装",
        }))
    }

    pub fn unbind_reference(&self) -> Result<Value, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.live_process.is_some() {
            return Err("请先停止实时补音链路，再解除歌手或歌曲参考轨".into());
        }
        state.desired_reference = None;
        Ok(json!({
            "ok": true,
            "state": "reference-unbound-route-not-armed",
            "physicalAudioStarted": false,
            "desiredReference": Value::Null,
            "message": "补音参考已解除；现场输入与返回路由未启动",
        }))
    }

    pub fn start_live(&self, mut request: Value) -> Result<Value, String> {
        let desired_reference = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .desired_reference
            .clone();
        if let Some(binding) = desired_reference.as_ref() {
            for key in ["referencePath", "referenceVocalPath"] {
                let missing = request
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map_or(true, str::is_empty);
                if missing {
                    request[key] = binding.get(key).cloned().unwrap_or(Value::Null);
                }
            }
        }
        validate_live_start_request(&request)?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.live_process = None;
        let mut process = VocalLiveProcess::spawn(&request)?;
        let desired = state.desired_playback;
        let desired_rescue_enabled = state.desired_rescue_enabled;
        let desired_reference = state.desired_reference.clone();
        let sync_id = next_request_id(&mut state);
        process.exchange(
            &json!({"id": sync_id, "command": "sync_playback", "seconds": desired.seconds, "playing": desired.playing}),
            sync_id,
        )?;
        let rescue_id = next_request_id(&mut state);
        process.exchange(
            &json!({"id": rescue_id, "command": "set_rescue_enabled", "enabled": desired_rescue_enabled}),
            rescue_id,
        )?;
        let status_id = next_request_id(&mut state);
        let mut status =
            process.exchange(&json!({"id": status_id, "command": "status"}), status_id)?;
        status["desiredPlayback"] = desired_playback_json(desired);
        status["desiredRescueEnabled"] = json!(desired_rescue_enabled);
        status["desiredReference"] = desired_reference.unwrap_or(Value::Null);
        state.live_process = Some(process);
        Ok(status)
    }

    pub fn stop_live(&self) -> Result<Value, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(mut process) = state.live_process.take() else {
            return Ok(json!({"ok": true, "state": "disarmed", "physicalAudioStarted": false}));
        };
        let request_id = next_request_id(&mut state);
        process.exchange(&json!({"id": request_id, "command": "stop"}), request_id)
    }

    fn request(&self, mut payload: Value) -> Result<Value, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let request_id = next_request_id(&mut state);
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
        let child = command
            .spawn()
            .map_err(|error| format!("无法启动 {}：{error}", executable.display()))?;
        Self::from_child(child)
    }

    fn from_child(mut child: Child) -> Result<Self, String> {
        let mut stdin = child.stdin.take().ok_or("Vocal Engine stdin 不可用")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("Vocal Engine stdout 不可用")?);
        let (requests, receiver) =
            mpsc::sync_channel::<(Value, SyncSender<Result<Value, String>>)>(1);
        std::thread::spawn(move || {
            while let Ok((payload, reply)) = receiver.recv() {
                let result = (|| {
                    serde_json::to_writer(&mut stdin, &payload)
                        .map_err(|error| error.to_string())?;
                    stdin
                        .write_all(b"\n")
                        .and_then(|_| stdin.flush())
                        .map_err(|error| error.to_string())?;
                    let mut line = String::new();
                    if stdout
                        .read_line(&mut line)
                        .map_err(|error| error.to_string())?
                        == 0
                    {
                        return Err("Vocal Engine 控制进程已退出".into());
                    }
                    serde_json::from_str::<Value>(&line).map_err(|error| error.to_string())
                })();
                let failed = result.is_err();
                let _ = reply.send(result);
                if failed {
                    break;
                }
            }
        });
        Ok(Self { child, requests })
    }

    fn exchange(&mut self, payload: &Value, request_id: u64) -> Result<Value, String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.requests
            .try_send((payload.clone(), reply))
            .map_err(|_| "Vocal Engine 控制通道不可用")?;
        let response = match response.recv_timeout(Duration::from_secs(2)) {
            Ok(result) => result?,
            Err(error) => {
                // Killing the owned child closes both pipes and releases its I/O worker.
                let _ = self.child.kill();
                let _ = self.child.wait();
                return Err(format!("Vocal Engine 请求超时或控制通道断开：{error}"));
            }
        };
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

impl VocalLiveProcess {
    fn spawn(request: &Value) -> Result<Self, String> {
        let executable = resolve_vocal_engine_executable()?;
        let input = required_string(request, "inputDevice")?;
        let output = required_string(request, "outputDevice")?;
        let reference = required_existing_file(request, "referencePath")?;
        let reference_vocal = required_existing_file(request, "referenceVocalPath")?;
        let input_channel = bounded_u64(request, "inputChannel", 0, 63)?;
        let output_channel = bounded_u64(request, "outputChannel", 0, 63)?;
        let gain_db = bounded_f64(request, "gainDb", -60.0, 0.0)?;
        let mut command = Command::new(&executable);
        command
            .arg("live-control-stdio")
            .arg("--arm")
            .arg("--input")
            .arg(input)
            .arg("--output")
            .arg(output)
            .arg("--input-channel")
            .arg(input_channel.to_string())
            .arg("--output-channel")
            .arg(output_channel.to_string())
            .arg("--gain-db")
            .arg(gain_db.to_string())
            .arg("--enable-pitch-correction")
            .arg("--enable-vocal-dynamics")
            .arg("--enable-vocal-quality")
            .arg("--enable-adaptive-blend")
            .arg("--enable-reference-rescue")
            .arg("--reference")
            .arg(reference)
            .arg("--reference-vocal")
            .arg(reference_vocal)
            .arg("--vocal-preset")
            .arg(
                request
                    .get("preset")
                    .and_then(Value::as_str)
                    .unwrap_or("professional"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let child = command
            .spawn()
            .map_err(|error| format!("无法启动 {}：{error}", executable.display()))?;
        Ok(Self(VocalControlProcess::from_child(child)?))
    }

    fn exchange(&mut self, payload: &Value, request_id: u64) -> Result<Value, String> {
        self.0.exchange(payload, request_id)
    }
}

fn next_request_id(state: &mut BridgeState) -> u64 {
    state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
    state.next_request_id
}

fn desired_playback_json(value: DesiredPlayback) -> Value {
    json!({"deck": value.deck, "seconds": value.seconds, "playing": value.playing})
}

fn validate_live_start_request(request: &Value) -> Result<(), String> {
    for key in ["operatorConfirmed", "routeVerified", "dryFallbackVerified"] {
        if request.get(key).and_then(Value::as_bool) != Some(true) {
            return Err(format!("安全拒绝：{key} 尚未确认"));
        }
    }
    let input = required_string(request, "inputDevice")?;
    let output = required_string(request, "outputDevice")?;
    if !input.to_ascii_lowercase().contains("qu-16")
        || !output.to_ascii_lowercase().contains("qu-16")
    {
        return Err("安全拒绝：输入与返回必须是已验证的 Qu-16 端点".into());
    }
    required_existing_file(request, "referencePath")?;
    required_existing_file(request, "referenceVocalPath")?;
    Ok(())
}

fn required_string(request: &Value, key: &str) -> Result<String, String> {
    request
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少 {key}"))
}

fn required_existing_file(request: &Value, key: &str) -> Result<String, String> {
    let value = required_string(request, key)?;
    if !Path::new(&value).is_file() {
        return Err(format!("{key} 文件不存在：{value}"));
    }
    Ok(value)
}

fn bounded_u64(request: &Value, key: &str, minimum: u64, maximum: u64) -> Result<u64, String> {
    let value = request
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("缺少 {key}"))?;
    (minimum..=maximum)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| format!("{key} 超出范围"))
}

fn bounded_f64(request: &Value, key: &str, minimum: f64, maximum: f64) -> Result<f64, String> {
    let value = request
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("缺少 {key}"))?;
    (value.is_finite() && (minimum..=maximum).contains(&value))
        .then_some(value)
        .ok_or_else(|| format!("{key} 超出范围"))
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
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(windows)]
    #[test]
    fn unresponsive_control_child_is_killed_after_deadline() {
        let child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$null=[Console]::ReadLine(); Start-Sleep -Seconds 10",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let mut process = VocalControlProcess::from_child(child).unwrap();
        let start = std::time::Instant::now();
        let result = process.exchange(&json!({"id":1,"command":"status"}), 1);
        assert!(result.unwrap_err().contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(process.child.try_wait().unwrap().is_some());
    }

    #[test]
    fn development_binary_candidate_is_repo_relative() {
        let path = resolve_vocal_engine_executable().expect("release engine should exist for P14");
        assert!(path.ends_with(if cfg!(windows) {
            "king-vocal-engine.exe"
        } else {
            "king-vocal-engine"
        }));
    }

    #[test]
    fn deck_reference_binding_never_starts_physical_audio() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "king-vocal-reference-binding-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create binding fixture directory");
        let media = directory.join("song.flac");
        let reference = directory.join("reference.json");
        let reference_vocal = directory.join("singer-reference.flac");
        fs::write(&media, b"song").expect("write media fixture");
        fs::write(&reference, b"{}").expect("write reference fixture");
        fs::write(&reference_vocal, b"voice").expect("write vocal fixture");

        let runtime = VocalRuntimeBridge::default();
        let response = runtime
            .bind_reference(json!({
                "profileId": "singer-1",
                "displayName": "Singer",
                "mediaPath": media,
                "referencePath": reference,
                "referenceVocalPath": reference_vocal,
            }))
            .expect("bind generated singer reference");
        assert_eq!(response["physicalAudioStarted"], false);
        assert_eq!(response["state"], "reference-ready-route-not-armed");

        let status = runtime.live_status().expect("read disarmed live status");
        assert_eq!(status["state"], "disarmed");
        assert_eq!(status["physicalAudioStarted"], false);
        assert_eq!(status["desiredReference"]["profileId"], "singer-1");

        let unbound = runtime
            .unbind_reference()
            .expect("unbind generated singer reference");
        assert_eq!(unbound["physicalAudioStarted"], false);
        assert_eq!(unbound["desiredReference"], Value::Null);
        let status = runtime.live_status().expect("read unbound live status");
        assert_eq!(status["desiredReference"], Value::Null);
        fs::remove_dir_all(directory).expect("remove binding fixture directory");
    }
}
