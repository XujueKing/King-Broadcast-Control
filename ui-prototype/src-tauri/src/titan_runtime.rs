use serde::Serialize;
use serde_json::Value;
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};

const TITAN_WEB_API_PORT: u16 = 4430;
const TITAN_TIMEOUT: Duration = Duration::from_millis(1_500);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanStatus {
    connected: bool,
    host: String,
    port: u16,
    device_name: String,
    serial: Option<u64>,
    software_version: String,
    show_name: String,
    hardware_identifier: String,
    dmx_enabled: Option<bool>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanPlaybackHandle {
    titan_id: Option<u64>,
    handle_type: String,
    legend: String,
    active: bool,
    selected: bool,
    user_numbers: Vec<i64>,
    group: String,
    page: Option<i64>,
    index: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanHandleSummary {
    titan_id: Option<u64>,
    handle_type: String,
    legend: String,
    user_numbers: Vec<i64>,
    group: String,
    page: Option<i64>,
    index: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanInventory {
    connected: bool,
    host: String,
    port: u16,
    device_name: String,
    cached_show_name: String,
    live_show_name: String,
    fixture_count: usize,
    group_count: usize,
    playback_count: usize,
    authoritative: bool,
    blocked_reason: String,
    fixtures: Vec<TitanHandleSummary>,
    groups: Vec<TitanHandleSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanPlaybackAction {
    ok: bool,
    action: &'static str,
    titan_id: u64,
    legend: String,
    message: String,
}

fn validate_host(host: &str) -> Result<&str, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("未配置 Titan 控制台 IP".to_string());
    }
    if host.len() > 253
        || host.contains('/')
        || host.contains('\\')
        || host.contains(':')
        || host.chars().any(char::is_whitespace)
        || !host.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '.' || character == '-'
        })
    {
        return Err("Titan 控制台地址格式无效；请只填写 IP 或主机名".to_string());
    }
    Ok(host)
}

fn parse_http_response(response: &[u8]) -> Result<&[u8], String> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Titan WebAPI 返回了无效 HTTP 响应".to_string())?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| "Titan WebAPI HTTP 头无法解析".to_string())?;
    let status = headers.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(format!("Titan WebAPI 请求失败：{status}"));
    }
    Ok(&response[header_end + 4..])
}

fn http_get(host: &str, path: &str) -> Result<Vec<u8>, String> {
    let host = validate_host(host)?;
    if !path.starts_with("/titan/") || path.contains('\r') || path.contains('\n') {
        return Err("Titan WebAPI 请求路径无效".to_string());
    }
    let address = (host, TITAN_WEB_API_PORT)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析 Titan 地址 {host}：{error}"))?
        .next()
        .ok_or_else(|| format!("无法解析 Titan 地址 {host}"))?;
    let mut stream = TcpStream::connect_timeout(&address, TITAN_TIMEOUT)
        .map_err(|error| format!("无法连接 Titan {host}:{TITAN_WEB_API_PORT}：{error}"))?;
    stream
        .set_read_timeout(Some(TITAN_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(TITAN_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{TITAN_WEB_API_PORT}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Titan WebAPI 请求发送失败：{error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Titan WebAPI 响应读取失败：{error}"))?;
    Ok(parse_http_response(&response)?.to_vec())
}

fn http_get_json(host: &str, path: &str) -> Result<Value, String> {
    let body = http_get(host, path)?;
    serde_json::from_slice(&body).map_err(|error| format!("Titan WebAPI JSON 解析失败：{error}"))
}

fn software_version(device: &Value) -> String {
    let version = &device["SoftwareVersion"];
    let major = version["_Major"].as_u64();
    let minor = version["_Minor"].as_u64();
    let revision = version["_Revision"].as_u64();
    match (major, minor, revision) {
        (Some(major), Some(minor), Some(revision)) => format!("{major}.{minor}.{revision}"),
        (Some(major), Some(minor), None) => format!("{major}.{minor}"),
        _ => "未知".to_string(),
    }
}

fn is_titan_device_info(device: &Value) -> bool {
    let version = &device["SoftwareVersion"];
    let has_version = version["_Major"].as_u64().is_some() && version["_Minor"].as_u64().is_some();
    let has_identity = device["Serial"].as_u64().is_some()
        || device["HardwareIdentifier"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty())
        || device["ComputerName"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty())
        || device["Legend"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty());
    has_version && has_identity
}

fn read_status(host: &str) -> Result<TitanStatus, String> {
    let host = validate_host(host)?;
    let device = http_get_json(host, "/titan/get/Titan/DeviceInfo")?;
    if !is_titan_device_info(&device) {
        return Err(format!(
            "{host}:{TITAN_WEB_API_PORT} 未返回可识别的 Titan DeviceInfo"
        ));
    }
    let device_name = device["Legend"]
        .as_str()
        .or_else(|| device["ComputerName"].as_str())
        .unwrap_or("Avolites Titan")
        .to_string();
    let version = software_version(&device);
    let show_name = device["ShowName"]
        .as_str()
        .unwrap_or("未命名 Show")
        .to_string();
    Ok(TitanStatus {
        connected: true,
        host: host.to_string(),
        port: TITAN_WEB_API_PORT,
        serial: device["Serial"].as_u64(),
        hardware_identifier: device["HardwareIdentifier"]
            .as_str()
            .unwrap_or("Avolites Titan Console")
            .to_string(),
        dmx_enabled: device["DmxEnabled"].as_bool(),
        message: format!("{device_name} · Titan {version} · Show {show_name}"),
        device_name,
        software_version: version,
        show_name,
    })
}

fn read_playbacks_from_path(host: &str, path: &str) -> Result<Vec<TitanPlaybackHandle>, String> {
    let handles = http_get_json(host, path)?;
    let handles = handles
        .as_array()
        .ok_or_else(|| "Titan Playback 列表格式无效".to_string())?;
    Ok(handles
        .iter()
        .map(|handle| TitanPlaybackHandle {
            titan_id: handle["titanId"].as_u64(),
            handle_type: handle["type"].as_str().unwrap_or("unknown").to_string(),
            legend: handle["Legend"].as_str().unwrap_or_default().to_string(),
            active: handle["Active"].as_bool().unwrap_or(false),
            selected: handle["Selected"].as_bool().unwrap_or(false),
            user_numbers: handle["UserNumber"]["userNumbers"]
                .as_array()
                .map(|values| values.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default(),
            group: handle["handleLocation"]["group"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            page: handle["handleLocation"]["page"].as_i64(),
            index: handle["handleLocation"]["index"].as_i64(),
        })
        .filter(|handle| handle.handle_type != "fixtureHandle")
        .collect())
}

fn read_playbacks(host: &str) -> Result<Vec<TitanPlaybackHandle>, String> {
    read_playbacks_from_path(host, "/titan/handles/Playbacks")
}

fn read_static_playbacks(host: &str) -> Result<Vec<TitanPlaybackHandle>, String> {
    read_playbacks_from_path(host, "/titan/handles/StaticPlaybacks")
}

fn read_triggerable_playbacks(host: &str) -> Result<Vec<TitanPlaybackHandle>, String> {
    let mut handles = read_playbacks(host)?;
    handles.extend(read_static_playbacks(host)?);
    handles.retain(is_triggerable_playback);
    Ok(handles)
}

fn read_handle_summaries(host: &str, path: &str) -> Result<Vec<TitanHandleSummary>, String> {
    let handles = http_get_json(host, path)?;
    let handles = handles
        .as_array()
        .ok_or_else(|| format!("Titan 句柄列表格式无效：{path}"))?;
    Ok(handles
        .iter()
        .map(|handle| TitanHandleSummary {
            titan_id: handle["titanId"].as_u64(),
            handle_type: handle["type"].as_str().unwrap_or("unknown").to_string(),
            legend: handle["Legend"].as_str().unwrap_or_default().to_string(),
            user_numbers: handle["UserNumber"]["userNumbers"]
                .as_array()
                .map(|values| values.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default(),
            group: handle["handleLocation"]["group"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            page: handle["handleLocation"]["page"].as_i64(),
            index: handle["handleLocation"]["index"].as_i64(),
        })
        .collect())
}

fn read_inventory(host: &str) -> Result<TitanInventory, String> {
    let host = validate_host(host)?;
    let device = http_get_json(host, "/titan/get/Titan/DeviceInfo")?;
    let device_name = device["Legend"]
        .as_str()
        .or_else(|| device["ComputerName"].as_str())
        .unwrap_or("Avolites Titan")
        .to_string();
    let cached_show_name = device["ShowName"].as_str().unwrap_or_default().to_string();
    let live_show_name = http_get_json(host, "/titan/get/Show/ShowName")?
        .as_str()
        .unwrap_or_default()
        .to_string();
    let fixtures = read_handle_summaries(host, "/titan/handles/Fixtures")?;
    let groups = read_handle_summaries(host, "/titan/handles/Groups")?;
    let playback_count = read_triggerable_playbacks(host)?.len();
    let authoritative = !live_show_name.trim().is_empty() && !fixtures.is_empty();
    let blocked_reason = if live_show_name.trim().is_empty() {
        "Titan WebAPI 当前没有暴露已加载 Show；不能把图纸数量当作真机数量".to_string()
    } else if fixtures.is_empty() {
        format!("Show {live_show_name} 没有返回 Fixture 句柄；灯位映射保持锁定")
    } else {
        String::new()
    };
    Ok(TitanInventory {
        connected: true,
        host: host.to_string(),
        port: TITAN_WEB_API_PORT,
        device_name,
        cached_show_name,
        live_show_name,
        fixture_count: fixtures.len(),
        group_count: groups.len(),
        playback_count,
        authoritative,
        blocked_reason,
        fixtures,
        groups,
    })
}

fn is_triggerable_playback(handle: &TitanPlaybackHandle) -> bool {
    matches!(
        handle.handle_type.as_str(),
        "cueHandle" | "chaseHandle" | "cueListHandle"
    )
}

fn verified_playback(
    host: &str,
    titan_id: u64,
    expected_show_name: &str,
) -> Result<TitanPlaybackHandle, String> {
    if titan_id == 0 {
        return Err("TitanId 不能为 0".to_string());
    }
    let expected_show_name = expected_show_name.trim();
    if expected_show_name.is_empty() {
        return Err("缺少已绑定的 Titan Show 名称；已拒绝控制".to_string());
    }
    let live_status = read_status(host)?;
    if live_status.show_name.trim().is_empty() || live_status.show_name != expected_show_name {
        return Err(format!(
            "Titan Show 身份不匹配：映射属于 {expected_show_name}，当前为 {}；已拒绝控制",
            if live_status.show_name.trim().is_empty() {
                "未知"
            } else {
                &live_status.show_name
            }
        ));
    }
    read_triggerable_playbacks(host)?
        .into_iter()
        .find(|handle| handle.titan_id == Some(titan_id) && is_triggerable_playback(handle))
        .ok_or_else(|| {
            format!("TitanId {titan_id} 不在当前 Show 的可触发 Playback/Cue 白名单中；已拒绝控制")
        })
}

fn fire_playback(
    host: &str,
    titan_id: u64,
    level: f64,
    always_refire: bool,
    expected_show_name: &str,
) -> Result<TitanPlaybackAction, String> {
    if !level.is_finite() || !(0.0..=1.0).contains(&level) {
        return Err("Titan Playback 电平必须在 0.0 到 1.0 之间".to_string());
    }
    let handle = verified_playback(host, titan_id, expected_show_name)?;
    let path = format!(
        "/titan/script/2/Playbacks/FirePlaybackAtLevel?handle_titanId={titan_id}&level_level={level:.3}&alwaysRefire={always_refire}"
    );
    http_get(host, &path)?;
    let legend = if handle.legend.trim().is_empty() {
        format!("Titan Playback {titan_id}")
    } else {
        handle.legend
    };
    Ok(TitanPlaybackAction {
        ok: true,
        action: "fire",
        titan_id,
        message: format!("已启动 {legend}"),
        legend,
    })
}

fn release_playback(
    host: &str,
    titan_id: u64,
    expected_show_name: &str,
) -> Result<TitanPlaybackAction, String> {
    let handle = verified_playback(host, titan_id, expected_show_name)?;
    // useMasterReleaseTime=true keeps the fade behaviour programmed on the Titan
    // console instead of inventing a separate fade curve in KING.
    let path = format!(
        "/titan/script/2/Playbacks/ReleasePlayback?handle_titanId={titan_id}&fadeTime=0&useMasterReleaseTime=true"
    );
    http_get(host, &path)?;
    let legend = if handle.legend.trim().is_empty() {
        format!("Titan Playback {titan_id}")
    } else {
        handle.legend
    };
    Ok(TitanPlaybackAction {
        ok: true,
        action: "release",
        titan_id,
        message: format!("已释放 {legend}"),
        legend,
    })
}

#[tauri::command]
pub async fn titan_status(host: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(read_status(&host)?).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_playbacks(host: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(read_triggerable_playbacks(&host)?).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_static_playbacks(host: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(read_static_playbacks(&host)?).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_inventory(host: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(read_inventory(&host)?).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_fire_playback(
    host: String,
    titan_id: u64,
    level: f64,
    always_refire: bool,
    expected_show_name: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(fire_playback(
            &host,
            titan_id,
            level,
            always_refire,
            &expected_show_name,
        ))
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_release_playback(
    host: String,
    titan_id: u64,
    expected_show_name: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(release_playback(&host, titan_id, &expected_show_name)?)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_response() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n\"11.3\"";
        assert_eq!(parse_http_response(response).unwrap(), b"\"11.3\"");
    }

    #[test]
    fn rejects_url_in_host_field() {
        assert!(validate_host("http://192.168.1.154").is_err());
        assert_eq!(validate_host("192.168.1.154").unwrap(), "192.168.1.154");
    }

    #[test]
    fn playback_control_requires_a_bound_show_identity() {
        let error = verified_playback("127.0.0.1", 42, "")
            .expect_err("missing show identity must fail before network access");
        assert!(error.contains("Show"));
    }

    #[test]
    fn formats_titan_version() {
        let value = serde_json::json!({"SoftwareVersion":{"_Major":11,"_Minor":3,"_Revision":5}});
        assert_eq!(software_version(&value), "11.3.5");
    }

    #[test]
    fn validates_titan_device_fingerprint() {
        let valid = serde_json::json!({
            "Legend": "TT-00608",
            "Serial": 608,
            "SoftwareVersion": {"_Major": 11, "_Minor": 3, "_Revision": 5}
        });
        assert!(is_titan_device_info(&valid));
        assert!(!is_titan_device_info(
            &serde_json::json!({"Legend": "router"})
        ));
        assert!(!is_titan_device_info(&serde_json::json!({
            "SoftwareVersion": {"_Major": 11, "_Minor": 3}
        })));
    }

    #[test]
    fn only_programmed_playback_types_are_triggerable() {
        let playback = |handle_type: &str| TitanPlaybackHandle {
            titan_id: Some(7),
            handle_type: handle_type.to_string(),
            legend: String::new(),
            active: false,
            selected: false,
            user_numbers: Vec::new(),
            group: "Playbacks".to_string(),
            page: Some(0),
            index: Some(0),
        };
        assert!(is_triggerable_playback(&playback("cueHandle")));
        assert!(is_triggerable_playback(&playback("chaseHandle")));
        assert!(is_triggerable_playback(&playback("cueListHandle")));
        assert!(!is_triggerable_playback(&playback("fixtureHandle")));
        let mut roller_playback = playback("cueHandle");
        roller_playback.group = "RollerA".to_string();
        assert!(is_triggerable_playback(&roller_playback));
        let mut static_playback = playback("cueHandle");
        static_playback.group = "StaticPlaybacks".to_string();
        assert!(is_triggerable_playback(&static_playback));
    }

    #[test]
    fn rejects_non_titan_paths() {
        assert!(http_get("127.0.0.1", "/other/path").is_err());
        assert!(http_get("127.0.0.1", "/titan/get/Titan/DeviceInfo\r\nInjected: yes").is_err());
    }
}
