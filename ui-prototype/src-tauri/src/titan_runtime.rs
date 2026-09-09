use serde::Serialize;
use serde_json::Value;
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use crate::network_discovery;

const TITAN_WEB_API_PORT: u16 = 4430;
const TITAN_TIMEOUT: Duration = Duration::from_millis(1_500);

static AUTOMATION_GENERATION: AtomicU64 = AtomicU64::new(0);
static TITAN_WRITE_LOCK: Mutex<()> = Mutex::new(());
thread_local! { static CLEANUP_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) }; }
thread_local! { static COMMAND_GENERATION: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) }; }

fn check_command_current() -> Result<(), String> {
    if CLEANUP_DEADLINE.with(|deadline| deadline.get().is_some_and(|time| Instant::now() >= time)) {
        return Err("收光操作超时，未确认全部归零".into());
    }
    COMMAND_GENERATION.with(|current| {
        if current
            .get()
            .is_some_and(|generation| generation != AUTOMATION_GENERATION.load(Ordering::SeqCst))
        {
            Err("灯光指令已取消".into())
        } else {
            Ok(())
        }
    })
}

fn with_titan_command<T>(
    generation: Option<u64>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if let Some(generation) = generation {
        AUTOMATION_GENERATION.fetch_max(generation, Ordering::SeqCst);
    }
    let _guard = TITAN_WRITE_LOCK.lock().map_err(|_| "灯光控制锁异常")?;
    COMMAND_GENERATION.with(|current| current.set(generation));
    let result = check_command_current().and_then(|_| operation());
    COMMAND_GENERATION.with(|current| current.set(None));
    result
}

fn cleanup_lighting<T>(operation: impl FnOnce() -> T) -> T {
    let saved = COMMAND_GENERATION.with(|current| current.replace(None));
    let previous_deadline = CLEANUP_DEADLINE
        .with(|deadline| deadline.replace(Some(Instant::now() + Duration::from_secs(3))));
    let result = operation();
    COMMAND_GENERATION.with(|current| current.set(saved));
    CLEANUP_DEADLINE.with(|deadline| deadline.set(previous_deadline));
    result
}

fn wait_for_lighting(duration: Duration) -> Result<(), String> {
    let deadline = Instant::now() + duration;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        check_command_current()?;
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
    check_command_current()
}

#[tauri::command]
pub fn titan_cancel_automation(generation: u64) {
    AUTOMATION_GENERATION.fetch_max(generation, Ordering::SeqCst);
}

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

const KINGCLUB_GATLING_SHOW: &str = "2024.12.28";
const KINGCLUB_GATLING_GROUP_TITAN_ID: u64 = 17_790;
const KINGCLUB_GATLING_FIXTURE_TITAN_ID: u64 = 17_636;
const KINGCLUB_GATLING_SPEED_CONTROL_ID: u64 = 1_935;
const KINGCLUB_GATLING_SPEED_FUNCTION_ID: u64 = 1;
const KINGCLUB_GATLING_TARGET_TTL: Duration = Duration::from_secs(10);
const KINGCLUB_GATLING_PALETTES: [u64; 8] = [
    33_187, 33_207, 33_214, 33_219, 33_227, 33_234, 33_240, 33_249,
];
const KINGCLUB_BEAM_FIXTURE_TITAN_IDS: [u64; 25] = [
    3_511, 3_512, 3_513, 3_514, 3_515, 3_516, 3_517, 3_518, 3_519, 3_520, 3_521, 3_522, 3_523,
    3_524, 3_525, 3_526, 3_527, 3_528, 3_529, 3_530, 3_703, 3_704, 3_705, 3_706, 15_676,
];
const KINGCLUB_BEAM_ROWS_SOUTH_TO_NORTH: [&[u64]; 6] = [
    &[3_527, 3_528, 3_529, 3_530],
    &[3_526, 3_525, 3_524, 3_523],
    &[3_522, 3_520, 3_517, 3_516],
    &[3_521, 3_519, 3_518, 3_515],
    &[3_704, 3_705, 3_511, 3_514, 15_676],
    &[3_703, 3_706, 3_512, 3_513],
];
const KINGCLUB_BEAM_WALK_LEVEL: f64 = 100.0;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanGatlingAction {
    ok: bool,
    fixture_titan_id: u64,
    palette_titan_id: Option<u64>,
    dimmer_percent: Option<f64>,
    speed_value: Option<f64>,
    message: String,
}

#[derive(Clone)]
struct GatlingPulseTarget {
    host: String,
    show_name: String,
    fixture_location: String,
    validated_at: Instant,
    last_level: f64,
    last_speed: Option<f64>,
    speed_updated_at: Instant,
}

static GATLING_PULSE_TARGET: OnceLock<Mutex<Option<GatlingPulseTarget>>> = OnceLock::new();

fn gatling_pulse_target_cache() -> &'static Mutex<Option<GatlingPulseTarget>> {
    GATLING_PULSE_TARGET.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanBeamAction {
    ok: bool,
    fixture_count: usize,
    dimmer_percent: Option<f64>,
    shutter_open: Option<bool>,
    pan_value: Option<f64>,
    tilt_value: Option<f64>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitanBeamShowAction {
    ok: bool,
    fixture_count: usize,
    bpm: f64,
    beat_interval_ms: u64,
    beats: usize,
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

fn same_ipv4_subnet(local: Ipv4Addr, remote: Ipv4Addr) -> bool {
    let local = local.octets();
    let remote = remote.octets();
    local[..3] == remote[..3]
}

fn local_address_for_titan(remote: SocketAddr) -> Option<SocketAddr> {
    let IpAddr::V4(remote_ip) = remote.ip() else {
        return None;
    };
    local_ip_address::list_afinet_netifas()
        .ok()?
        .into_iter()
        .filter_map(|(_, address)| match address {
            IpAddr::V4(address)
                if !address.is_loopback()
                    && !address.is_link_local()
                    && same_ipv4_subnet(address, remote_ip) =>
            {
                Some(SocketAddr::new(IpAddr::V4(address), 0))
            }
            _ => None,
        })
        .next()
}

fn connect_titan(address: SocketAddr) -> Result<TcpStream, String> {
    if let Some(local_address) = local_address_for_titan(address) {
        let domain = if address.is_ipv4() {
            Domain::IPV4
        } else {
            Domain::IPV6
        };
        let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))
            .map_err(|error| format!("无法创建 Titan 局域网连接：{error}"))?;
        socket
            .bind(&local_address.into())
            .map_err(|error| format!("无法绑定 Titan 局域网地址 {local_address}：{error}"))?;
        socket
            .connect_timeout(&address.into(), TITAN_TIMEOUT)
            .map_err(|error| format!("无法从 {local_address} 连接 Titan {address}：{error}"))?;
        return Ok(socket.into());
    }
    TcpStream::connect_timeout(&address, TITAN_TIMEOUT)
        .map_err(|error| format!("无法连接 Titan {address}：{error}"))
}

fn http_get(host: &str, path: &str) -> Result<Vec<u8>, String> {
    check_command_current()?;
    let host = validate_host(host)?;
    if !path.starts_with("/titan/") || path.contains('\r') || path.contains('\n') {
        return Err("Titan WebAPI 请求路径无效".to_string());
    }
    let address = (host, TITAN_WEB_API_PORT)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析 Titan 地址 {host}：{error}"))?
        .next()
        .ok_or_else(|| format!("无法解析 Titan 地址 {host}"))?;
    let deadline = Instant::now() + TITAN_TIMEOUT;
    let mut stream = connect_titan(address)?;
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(TITAN_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{TITAN_WEB_API_PORT}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    check_command_current()?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Titan WebAPI 请求发送失败：{error}"))?;
    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        check_command_current()?;
        if Instant::now() >= deadline {
            return Err("Titan WebAPI 响应超时".into());
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => response.extend_from_slice(&buffer[..length]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(error) => return Err(format!("Titan WebAPI 响应读取失败：{error}")),
        }
        if response.len() > 8 * 1024 * 1024 {
            return Err("Titan WebAPI 响应超出限制".into());
        }
    }
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
    if let Err(error) = http_get(host, &path).and_then(|_| check_command_current()) {
        // A cancelled/failed reply does not prove the console ignored the Fire.
        // Release the already-verified handle before admitting another command.
        let released = cleanup_lighting(|| release_playback(host, titan_id, expected_show_name));
        return Err(match released {
            Ok(_) => error,
            Err(cleanup) => format!("{error}；Playback 释放未确认：{cleanup}"),
        });
    }
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

fn validate_gatling_levels(
    palette_titan_id: Option<u64>,
    dimmer_percent: Option<f64>,
    speed_value: Option<f64>,
) -> Result<(), String> {
    if palette_titan_id.is_some_and(|id| !KINGCLUB_GATLING_PALETTES.contains(&id)) {
        return Err("加特林颜色不在现场已核对的 Colour 70-77 白名单中".to_string());
    }
    if dimmer_percent.is_some_and(|level| !level.is_finite() || !(0.0..=100.0).contains(&level)) {
        return Err("加特林自动亮度超出灯具 0%-100% 范围".to_string());
    }
    if speed_value.is_some_and(|speed| !speed.is_finite() || !(0.0..=1.0).contains(&speed)) {
        return Err("加特林自动速度超出灯具归一化 0-1 范围".to_string());
    }
    Ok(())
}

fn selected_fixture_ids(host: &str) -> Result<Vec<u64>, String> {
    let handles = http_get_json(host, "/titan/handles/Fixtures")?;
    let handles = handles
        .as_array()
        .ok_or_else(|| "Titan Fixture 列表格式无效".to_string())?;
    Ok(handles
        .iter()
        .filter(|handle| {
            handle["type"].as_str() == Some("fixtureHandle")
                && handle["Selected"].as_bool() == Some(true)
        })
        .filter_map(|handle| handle["titanId"].as_u64())
        .collect())
}

fn verified_site_handle(
    host: &str,
    path: &str,
    titan_id: u64,
    handle_type: &str,
) -> Result<(), String> {
    let handles = read_handle_summaries(host, path)?;
    if handles
        .iter()
        .any(|handle| handle.titan_id == Some(titan_id) && handle.handle_type == handle_type)
    {
        Ok(())
    } else {
        Err(format!(
            "TitanId {titan_id} 不在当前 Show 的 {handle_type} 白名单中"
        ))
    }
}

fn update_gatling(
    host: &str,
    expected_show_name: &str,
    palette_titan_id: Option<u64>,
    dimmer_percent: Option<f64>,
    speed_value: Option<f64>,
) -> Result<TitanGatlingAction, String> {
    validate_gatling_levels(palette_titan_id, dimmer_percent, speed_value)?;
    if expected_show_name.trim() != KINGCLUB_GATLING_SHOW {
        return Err("加特林现场配置只绑定 Show 2024.12.28".to_string());
    }
    let status = read_status(host)?;
    if status.show_name != expected_show_name {
        return Err(format!(
            "Titan Show 身份不匹配：需要 {expected_show_name}，当前为 {}",
            status.show_name
        ));
    }
    verified_site_handle(
        host,
        "/titan/handles/Groups",
        KINGCLUB_GATLING_GROUP_TITAN_ID,
        "groupHandle",
    )?;
    verified_site_handle(
        host,
        "/titan/handles/Fixtures",
        KINGCLUB_GATLING_FIXTURE_TITAN_ID,
        "fixtureHandle",
    )?;
    if let Some(palette_id) = palette_titan_id {
        verified_site_handle(host, "/titan/handles/Colours", palette_id, "paletteHandle")?;
    }

    // Group 59 is useful as a site identity check, but operators can edit its
    // membership on the desk. Select the physically verified Gatling fixture
    // directly so a stale group can never pull a beam into automatic updates.
    let fixtures = read_handle_summaries(host, "/titan/handles/Fixtures")?;
    let gatling_fixture = beam_fixture_handle(&fixtures, KINGCLUB_GATLING_FIXTURE_TITAN_ID)?;
    let location = fixture_handle_location(gatling_fixture)?;
    http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear")?;
    std::thread::sleep(Duration::from_millis(50));
    if !selected_fixture_ids(host)?.is_empty() {
        http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear")?;
        std::thread::sleep(Duration::from_millis(50));
    }
    let select_path = format!(
        "/titan/script/2/Programmer/Editor/Selection/SelectFixture?handle_location={location}"
    );
    http_get(host, &select_path)?;
    std::thread::sleep(Duration::from_millis(50));
    let selected = selected_fixture_ids(host)?;
    if selected != [KINGCLUB_GATLING_FIXTURE_TITAN_ID] {
        let _ = http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear");
        return Err(format!(
            "加特林 Group 59 当前选择了非预期灯具 {:?}；已拒绝输出",
            selected
        ));
    }

    let operation = (|| {
        if let Some(palette_id) = palette_titan_id {
            let path = format!(
                "/titan/script/2/Palette/ApplyPalette?handle_titanId={palette_id}&usePaletteTimes=false"
            );
            http_get(host, &path)?;
        }
        if let Some(level) = dimmer_percent {
            let path = format!(
                "/titan/script/2/Programmer/Editor/Fixtures/SetDimmerLevel?level={level:.3}"
            );
            http_get(host, &path)?;
        }
        if let Some(speed) = speed_value {
            let path = format!(
                "/titan/script/2/Programmer/Editor/Fixtures/SetControlValueById?controlId={KINGCLUB_GATLING_SPEED_CONTROL_ID}&functionId={KINGCLUB_GATLING_SPEED_FUNCTION_ID}&value={speed:.3}&programmer=true&createRestorePoint=false"
            );
            http_get(host, &path)?;
        }
        Ok::<(), String>(())
    })();
    let _ = http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear");
    operation?;

    if let Ok(mut cached) = gatling_pulse_target_cache().lock() {
        *cached = Some(GatlingPulseTarget {
            host: host.to_string(),
            show_name: expected_show_name.to_string(),
            fixture_location: location,
            validated_at: Instant::now(),
            last_level: dimmer_percent.unwrap_or(4.0),
            last_speed: speed_value,
            speed_updated_at: Instant::now(),
        });
    }

    Ok(TitanGatlingAction {
        ok: true,
        fixture_titan_id: KINGCLUB_GATLING_FIXTURE_TITAN_ID,
        palette_titan_id,
        dimmer_percent,
        speed_value,
        message: "暗场加特林已更新".to_string(),
    })
}

fn validated_gatling_pulse_target(
    host: &str,
    expected_show_name: &str,
) -> Result<GatlingPulseTarget, String> {
    let status = read_status(host)?;
    if status.show_name != expected_show_name {
        return Err(format!(
            "Titan Show 身份不匹配：需要 {expected_show_name}，当前为 {}",
            status.show_name
        ));
    }

    if let Ok(cached) = gatling_pulse_target_cache().lock() {
        if let Some(target) = cached.as_ref() {
            if target.host == host
                && target.show_name == expected_show_name
                && target.validated_at.elapsed() < KINGCLUB_GATLING_TARGET_TTL
            {
                return Ok(target.clone());
            }
        }
    }

    let fixtures = read_handle_summaries(host, "/titan/handles/Fixtures")?;
    let fixture = beam_fixture_handle(&fixtures, KINGCLUB_GATLING_FIXTURE_TITAN_ID)?;
    let target = GatlingPulseTarget {
        host: host.to_string(),
        show_name: expected_show_name.to_string(),
        fixture_location: fixture_handle_location(fixture)?,
        validated_at: Instant::now(),
        last_level: 4.0,
        last_speed: None,
        speed_updated_at: Instant::now(),
    };
    if let Ok(mut cached) = gatling_pulse_target_cache().lock() {
        *cached = Some(target.clone());
    }
    Ok(target)
}

fn set_fixture_location_level(
    host: &str,
    fixture_location: &str,
    value_percent: f64,
    old_value_percent: f64,
) -> Result<(), String> {
    let value = value_percent / 100.0;
    let old_value = old_value_percent / 100.0;
    let path = format!(
        "/titan/script/2/Fixtures/PresetLevelHandle?handle_location={fixture_location}&value={value:.3}&oldValue={old_value:.3}"
    );
    http_get(host, &path)?;
    Ok(())
}

fn should_update_speed(target: &GatlingPulseTarget, speed: f64) -> bool {
    target.last_speed.is_none_or(|last| {
        (last - speed).abs() >= 0.005
            && (target.speed_updated_at.elapsed() >= Duration::from_secs(1)
                || (speed <= 0.22 && last > 0.22))
    })
}

fn pulse_gatling(
    host: &str,
    expected_show_name: &str,
    peak_dimmer_percent: f64,
    base_dimmer_percent: f64,
    pulse_millis: u64,
    speed_value: Option<f64>,
) -> Result<TitanGatlingAction, String> {
    validate_gatling_levels(None, Some(peak_dimmer_percent), speed_value)?;
    validate_gatling_levels(None, Some(base_dimmer_percent), None)?;
    if expected_show_name.trim() != KINGCLUB_GATLING_SHOW {
        return Err("加特林现场配置只绑定 Show 2024.12.28".to_string());
    }
    let target = validated_gatling_pulse_target(host, expected_show_name)?;
    let pulse_result = set_fixture_location_level(
        host,
        &target.fixture_location,
        peak_dimmer_percent,
        target.last_level,
    )
    .and_then(|_| wait_for_lighting(Duration::from_millis(pulse_millis.clamp(40, 140))));
    let reset_result = cleanup_lighting(|| {
        if let Err(error) = set_fixture_location_level(
            host,
            &target.fixture_location,
            base_dimmer_percent,
            peak_dimmer_percent,
        ) {
            let _ = set_fixture_location_level(
                host,
                &target.fixture_location,
                base_dimmer_percent,
                peak_dimmer_percent,
            );
            return Err(error);
        }
        Ok::<(), String>(())
    });
    reset_result?;
    pulse_result?;
    if let Ok(mut cached) = gatling_pulse_target_cache().lock() {
        if let Some(current) = cached.as_mut() {
            if current.host == host && current.show_name == expected_show_name {
                current.last_level = base_dimmer_percent;
            }
        }
    }
    // Brightness follows the beat first; motion speed is coalesced after reset.
    if let Some(speed) = speed_value.filter(|speed| should_update_speed(&target, *speed)) {
        http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear")?;
        http_get(
            host,
            &format!(
                "/titan/script/2/Programmer/Editor/Selection/SelectFixture?handle_location={}",
                target.fixture_location
            ),
        )?;
        let speed_result = (|| {
            let selected = selected_fixture_ids(host)?;
            if selected != vec![KINGCLUB_GATLING_FIXTURE_TITAN_ID] {
                return Err("加特林选择与已核验灯具不一致".into());
            }
            http_get(host,&format!("/titan/script/2/Programmer/Editor/Fixtures/SetControlValueById?controlId={KINGCLUB_GATLING_SPEED_CONTROL_ID}&functionId={KINGCLUB_GATLING_SPEED_FUNCTION_ID}&value={speed:.3}&programmer=true&createRestorePoint=false"))?;
            Ok::<(), String>(())
        })();
        cleanup_lighting(|| {
            let _ = http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear");
        });
        speed_result?;
        if let Ok(mut cached) = gatling_pulse_target_cache().lock() {
            if let Some(current) = cached.as_mut() {
                current.last_speed = Some(speed);
                current.speed_updated_at = Instant::now();
            }
        }
    }
    Ok(TitanGatlingAction {
        ok: true,
        fixture_titan_id: KINGCLUB_GATLING_FIXTURE_TITAN_ID,
        palette_titan_id: None,
        dimmer_percent: Some(peak_dimmer_percent),
        speed_value,
        message: "加特林已跟随音乐短促闪动".to_string(),
    })
}

fn validate_beam_level(dimmer_percent: Option<f64>) -> Result<(), String> {
    if dimmer_percent.is_some_and(|level| !level.is_finite() || !(0.0..=100.0).contains(&level)) {
        return Err("光束自动亮度超出灯具 0%-100% 范围".to_string());
    }
    Ok(())
}

fn validate_beam_position(control_name: &str, value: Option<f64>) -> Result<(), String> {
    if value.is_some_and(|position| !position.is_finite() || !(0.0..=1.0).contains(&position)) {
        return Err(format!("光束 {control_name} 位置必须在 0.0-1.0 范围内"));
    }
    Ok(())
}

fn verified_beam_fixture_handles(host: &str) -> Result<Vec<TitanHandleSummary>, String> {
    let fixtures = read_handle_summaries(host, "/titan/handles/Fixtures")?;
    let fixture_ids = fixtures
        .iter()
        .filter(|handle| handle.handle_type == "fixtureHandle")
        .filter_map(|handle| handle.titan_id)
        .collect::<std::collections::HashSet<_>>();
    if KINGCLUB_BEAM_FIXTURE_TITAN_IDS
        .iter()
        .any(|fixture_id| !fixture_ids.contains(fixture_id))
    {
        return Err("光束白名单与当前 Show Fixture 不一致；已拒绝输出".to_string());
    }
    Ok(fixtures)
}

fn fixture_handle_location(handle: &TitanHandleSummary) -> Result<String, String> {
    let page = handle
        .page
        .ok_or_else(|| "光束 Fixture 缺少页码".to_string())?;
    let index = handle
        .index
        .ok_or_else(|| "光束 Fixture 缺少位置".to_string())?;
    if handle.group != "Fixtures" || page < 0 || index < 0 {
        return Err("光束 Fixture 句柄位置无效".to_string());
    }
    // Titan's script HandleLocation syntax is one-based even though the
    // handles inventory reports zero-based page/index values.
    Ok(format!("Fixtures_{}_{}", page + 1, index + 1))
}

fn beam_fixture_handle<'a>(
    fixtures: &'a [TitanHandleSummary],
    titan_id: u64,
) -> Result<&'a TitanHandleSummary, String> {
    fixtures
        .iter()
        .find(|handle| handle.handle_type == "fixtureHandle" && handle.titan_id == Some(titan_id))
        .ok_or_else(|| format!("未找到光束 Fixture TitanId {titan_id}"))
}

fn add_beam_fixture_to_selection(
    host: &str,
    fixtures: &[TitanHandleSummary],
    titan_id: u64,
) -> Result<(), String> {
    let fixture = beam_fixture_handle(fixtures, titan_id)?;
    let location = fixture_handle_location(fixture)?;
    let path = format!(
        "/titan/script/2/Programmer/Editor/Selection/SelectFixture?handle_location={location}"
    );
    http_get(host, &path)?;
    Ok(())
}

fn select_beam_fixture(
    host: &str,
    fixtures: &[TitanHandleSummary],
    titan_id: u64,
) -> Result<(), String> {
    http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear")?;
    add_beam_fixture_to_selection(host, fixtures, titan_id)
}

fn select_beam_row(
    host: &str,
    fixtures: &[TitanHandleSummary],
    titan_ids: &[u64],
) -> Result<(), String> {
    http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear")?;
    for titan_id in titan_ids {
        add_beam_fixture_to_selection(host, fixtures, *titan_id)?;
    }
    let mut selected = selected_fixture_ids(host)?;
    selected.sort_unstable();
    let mut expected = titan_ids.to_vec();
    expected.sort_unstable();
    if selected != expected {
        let _ = http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear");
        return Err(format!(
            "光束行选择与 A 编号不一致 {:?}；已拒绝输出",
            selected
        ));
    }
    Ok(())
}

fn set_fixture_preset_level(
    host: &str,
    fixture: &TitanHandleSummary,
    value: f64,
    old_value: f64,
) -> Result<(), String> {
    let location = fixture_handle_location(fixture)?;
    let path = format!(
        "/titan/script/2/Fixtures/PresetLevelHandle?handle_location={location}&value={value:.3}&oldValue={old_value:.3}"
    );
    http_get(host, &path)?;
    Ok(())
}

fn blackout_beams(
    host: &str,
    fixtures: &[TitanHandleSummary],
    close_shutter: bool,
) -> Result<(), String> {
    let mut first_error = None;
    for titan_id in KINGCLUB_BEAM_FIXTURE_TITAN_IDS {
        check_command_current()?;
        let result = beam_fixture_handle(fixtures, titan_id).and_then(|fixture| {
            set_fixture_preset_level(host, fixture, 0.0, KINGCLUB_BEAM_WALK_LEVEL / 100.0)
        });
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    let programmer = (|| {
        select_beam_row(host, fixtures, &KINGCLUB_BEAM_FIXTURE_TITAN_IDS)?;
        http_get(
            host,
            "/titan/script/2/Programmer/Editor/Fixtures/SetDimmerLevel?level=0",
        )?;
        if close_shutter {
            http_get(host,"/titan/script/2/Programmer/Editor/Fixtures/SetControlValueByName?controlName=Shutter&functionName=Open&value=0&programmer=true&createRestorePoint=false")?;
        }
        Ok::<(), String>(())
    })();
    let cleared = http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear");
    if let Some(error) = first_error {
        return Err(error);
    }
    programmer?;
    cleared?;
    Ok(())
}

fn update_beam(
    host: &str,
    expected_show_name: &str,
    dimmer_percent: Option<f64>,
    shutter_open: Option<bool>,
    pan_value: Option<f64>,
    tilt_value: Option<f64>,
) -> Result<TitanBeamAction, String> {
    validate_beam_level(dimmer_percent)?;
    validate_beam_position("Pan", pan_value)?;
    validate_beam_position("Tilt", tilt_value)?;
    if expected_show_name.trim() != KINGCLUB_GATLING_SHOW {
        return Err("光束现场配置只绑定 Show 2024.12.28".to_string());
    }
    let status = read_status(host)?;
    if status.show_name != expected_show_name {
        return Err(format!(
            "Titan Show 身份不匹配：需要 {expected_show_name}，当前为 {}",
            status.show_name
        ));
    }
    let fixtures = verified_beam_fixture_handles(host)?;

    let operation = (|| {
        for titan_id in KINGCLUB_BEAM_FIXTURE_TITAN_IDS {
            let fixture = beam_fixture_handle(&fixtures, titan_id)?;
            select_beam_fixture(host, &fixtures, titan_id)?;
            if let Some(level) = dimmer_percent {
                if level == 0.0 {
                    set_fixture_preset_level(host, fixture, 0.0, KINGCLUB_BEAM_WALK_LEVEL / 100.0)?;
                }
                let path = format!(
                    "/titan/script/2/Programmer/Editor/Fixtures/SetDimmerLevel?level={level:.3}"
                );
                http_get(host, &path)?;
            }
            if let Some(open) = shutter_open {
                let value = if open { 1.0 } else { 0.0 };
                let path = format!(
                    "/titan/script/2/Programmer/Editor/Fixtures/SetControlValueByName?controlName=Shutter&functionName=Open&value={value:.3}&programmer=true&createRestorePoint=false"
                );
                http_get(host, &path)?;
            }
            if let Some(value) = pan_value {
                let path = format!(
                    "/titan/script/2/Programmer/Editor/Fixtures/SetControlValueByName?controlName=Pan&functionName=Pan&value={value:.3}&programmer=true&createRestorePoint=false"
                );
                http_get(host, &path)?;
            }
            if let Some(value) = tilt_value {
                let path = format!(
                    "/titan/script/2/Programmer/Editor/Fixtures/SetControlValueByName?controlName=Tilt&functionName=Tilt&value={value:.3}&programmer=true&createRestorePoint=false"
                );
                http_get(host, &path)?;
            }
        }
        Ok::<(), String>(())
    })();
    if operation.is_err() {
        cleanup_lighting(|| blackout_beams(host, &fixtures, true))
            .map_err(|error| format!("光束收光未确认：{error}"))?;
    } else {
        cleanup_lighting(|| http_get(host, "/titan/script/2/Programmer/Editor/Selection/Clear"))?;
    }
    operation?;

    Ok(TitanBeamAction {
        ok: true,
        fixture_count: KINGCLUB_BEAM_FIXTURE_TITAN_IDS.len(),
        dimmer_percent,
        shutter_open,
        pan_value,
        tilt_value,
        message: "25 台光束节拍造型已更新".to_string(),
    })
}

fn run_beam_show(
    host: &str,
    expected_show_name: &str,
    bpm: f64,
    pan_value: f64,
    tilt_value: f64,
) -> Result<TitanBeamShowAction, String> {
    if !bpm.is_finite() || !(60.0..=200.0).contains(&bpm) {
        return Err("光束秀 BPM 必须在 60-200 范围内".to_string());
    }
    for (name, value) in [("Pan", pan_value), ("Tilt", tilt_value)] {
        validate_beam_position(name, Some(value))?;
    }
    if expected_show_name.trim() != KINGCLUB_GATLING_SHOW {
        return Err("光束现场配置只绑定 Show 2024.12.28".to_string());
    }
    let status = read_status(host)?;
    if status.show_name != expected_show_name {
        return Err(format!(
            "Titan Show 身份不匹配：需要 {expected_show_name}，当前为 {}",
            status.show_name
        ));
    }
    let fixtures = verified_beam_fixture_handles(host)?;

    let beat_interval = Duration::from_secs_f64(60.0 / bpm);
    let beat_interval_ms = beat_interval.as_millis() as u64;

    let operation = (|| {
        // Arming pre-positions the heads in blackout. The time-critical show
        // only changes direct fixture levels, so six rows stay on the BPM grid.
        let show_started = Instant::now();
        let mut previous_row: Option<&[u64]> = None;
        for (index, row) in KINGCLUB_BEAM_ROWS_SOUTH_TO_NORTH.iter().enumerate() {
            select_beam_row(host, &fixtures, row)?;
            let on_path = format!(
                "/titan/script/2/Programmer/Editor/Fixtures/SetDimmerLevel?level={KINGCLUB_BEAM_WALK_LEVEL:.3}"
            );
            http_get(host, &on_path)?;
            if let Some(previous) = previous_row {
                select_beam_row(host, &fixtures, previous)?;
                http_get(
                    host,
                    "/titan/script/2/Programmer/Editor/Fixtures/SetDimmerLevel?level=0",
                )?;
            }
            previous_row = Some(row);
            let deadline = show_started
                + Duration::from_secs_f64(beat_interval.as_secs_f64() * (index + 1) as f64);
            if let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                wait_for_lighting(remaining)?;
            }
        }
        if let Some(previous) = previous_row {
            select_beam_row(host, &fixtures, previous)?;
            http_get(
                host,
                "/titan/script/2/Programmer/Editor/Fixtures/SetDimmerLevel?level=0",
            )?;
        }
        Ok::<(), String>(())
    })();

    let cleanup = cleanup_lighting(|| blackout_beams(host, &fixtures, operation.is_err()));
    if let Err(error) = cleanup {
        return Err(format!("光束收光未确认：{error}"));
    }
    operation?;

    Ok(TitanBeamShowAction {
        ok: true,
        fixture_count: KINGCLUB_BEAM_FIXTURE_TITAN_IDS.len(),
        bpm,
        beat_interval_ms,
        beats: KINGCLUB_BEAM_ROWS_SOUTH_TO_NORTH.len(),
        message: "A组光束南区到北区六拍点缀已完成并归零".to_string(),
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
pub async fn titan_discover(host_hint: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let hosts = network_discovery::scan_tcp_subnet(
            &host_hint,
            TITAN_WEB_API_PORT,
            Duration::from_millis(180),
        )?;
        let statuses = hosts
            .into_iter()
            .filter_map(|host| read_status(&host).ok())
            .collect::<Vec<_>>();
        serde_json::to_value(statuses).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_fire_playback(
    host: String,
    generation: Option<u64>,
    titan_id: u64,
    level: f64,
    always_refire: bool,
    expected_show_name: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_titan_command(generation, || {
            serde_json::to_value(fire_playback(
                &host,
                titan_id,
                level,
                always_refire,
                &expected_show_name,
            )?)
            .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_release_playback(
    host: String,
    generation: Option<u64>,
    titan_id: u64,
    expected_show_name: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_titan_command(generation, || {
            serde_json::to_value(release_playback(&host, titan_id, &expected_show_name)?)
                .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_update_gatling(
    host: String,
    generation: Option<u64>,
    expected_show_name: String,
    palette_titan_id: Option<u64>,
    dimmer_percent: Option<f64>,
    speed_value: Option<f64>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_titan_command(generation, || {
            serde_json::to_value(update_gatling(
                &host,
                &expected_show_name,
                palette_titan_id,
                dimmer_percent,
                speed_value,
            )?)
            .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_pulse_gatling(
    host: String,
    generation: Option<u64>,
    expected_show_name: String,
    peak_dimmer_percent: f64,
    base_dimmer_percent: f64,
    pulse_millis: u64,
    speed_value: Option<f64>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_titan_command(generation, || {
            serde_json::to_value(pulse_gatling(
                &host,
                &expected_show_name,
                peak_dimmer_percent,
                base_dimmer_percent,
                pulse_millis,
                speed_value,
            )?)
            .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_update_beam(
    host: String,
    generation: Option<u64>,
    expected_show_name: String,
    dimmer_percent: Option<f64>,
    shutter_open: Option<bool>,
    pan_value: Option<f64>,
    tilt_value: Option<f64>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_titan_command(generation, || {
            serde_json::to_value(update_beam(
                &host,
                &expected_show_name,
                dimmer_percent,
                shutter_open,
                pan_value,
                tilt_value,
            )?)
            .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn titan_run_beam_show(
    host: String,
    generation: Option<u64>,
    expected_show_name: String,
    bpm: f64,
    pan_value: f64,
    tilt_value: f64,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_titan_command(generation, || {
            serde_json::to_value(run_beam_show(
                &host,
                &expected_show_name,
                bpm,
                pan_value,
                tilt_value,
            )?)
            .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_interrupts_a_long_show_and_rejects_queued_old_commands() {
        let generation = AUTOMATION_GENERATION.load(Ordering::SeqCst) + 1;
        let (sender, receiver) = std::sync::mpsc::channel();
        let running = std::thread::spawn(move || {
            with_titan_command(Some(generation), || {
                sender.send(()).unwrap();
                wait_for_lighting(Duration::from_secs(6))
            })
        });
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        titan_cancel_automation(generation + 1);
        assert!(running.join().unwrap().unwrap_err().contains("取消"));
        assert!(started.elapsed() < Duration::from_millis(300));
        assert!(
            with_titan_command::<()>(Some(generation), || panic!("stale write must not run"))
                .is_err()
        );
        assert!(with_titan_command(Some(generation + 1), || Ok(())).is_ok());
    }

    #[test]
    fn speed_coalescing_preserves_immediate_slow_song_reduction() {
        let target = GatlingPulseTarget {
            host: "mock".into(),
            show_name: "mock".into(),
            fixture_location: "mock".into(),
            validated_at: Instant::now(),
            last_level: 4.0,
            last_speed: Some(0.8),
            speed_updated_at: Instant::now(),
        };
        assert!(!should_update_speed(&target, 0.81));
        assert!(should_update_speed(&target, 0.18));
        let target = GatlingPulseTarget {
            last_speed: Some(0.18),
            speed_updated_at: Instant::now() - Duration::from_secs(2),
            ..target
        };
        assert!(!should_update_speed(&target, 0.18));
        assert!(should_update_speed(&target, 0.19));
    }

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
    fn detects_matching_site_subnet_without_accepting_tunnel_addresses() {
        assert!(same_ipv4_subnet(
            Ipv4Addr::new(192, 168, 1, 237),
            Ipv4Addr::new(192, 168, 1, 154)
        ));
        assert!(!same_ipv4_subnet(
            Ipv4Addr::new(198, 18, 0, 1),
            Ipv4Addr::new(192, 168, 1, 154)
        ));
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

    #[test]
    fn gatling_automation_uses_fixture_protocol_ranges() {
        assert!(validate_gatling_levels(Some(33_207), Some(10.0), Some(0.361)).is_ok());
        assert!(validate_gatling_levels(Some(33_207), Some(100.0), Some(1.0)).is_ok());
        assert!(validate_gatling_levels(Some(1), Some(10.0), Some(0.361)).is_err());
        assert!(validate_gatling_levels(Some(33_207), Some(100.1), Some(0.361)).is_err());
        assert!(validate_gatling_levels(Some(33_207), Some(10.0), Some(1.01)).is_err());
    }

    #[test]
    fn beam_automation_uses_verified_fixture_protocol_ranges() {
        assert_eq!(KINGCLUB_BEAM_FIXTURE_TITAN_IDS.len(), 25);
        assert_eq!(KINGCLUB_BEAM_ROWS_SOUTH_TO_NORTH.len(), 6);
        assert_eq!(
            KINGCLUB_BEAM_ROWS_SOUTH_TO_NORTH
                .iter()
                .map(|row| row.len())
                .sum::<usize>(),
            25
        );
        assert!(validate_beam_level(Some(0.0)).is_ok());
        assert!(validate_beam_level(Some(100.0)).is_ok());
        assert!(validate_beam_level(Some(100.1)).is_err());
    }
}
