//! Staff LAN API. The desktop is the sole playback owner; HTTP never exposes
//! arbitrary Tauri commands, local paths, or an independent player.
use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    pub deck: u8,
    pub token: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 4865,
            deck: 1,
            token: new_id() + &new_id(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Song {
    pub key: String,
    pub title: String,
    pub artist: String,
    pub duration_seconds: f64,
    pub accompaniment_available: bool,
    pub lyrics: Vec<Value>,
}
impl Song {
    fn id(&self) -> String {
        blake3::hash(self.key.as_bytes()).to_hex().to_string()
    }
    fn summary(&self) -> Value {
        json!({"id": self.id(), "title": self.title, "artist": self.artist,
        "durationSeconds": self.duration_seconds, "accompanimentAvailable": self.accompaniment_available,
        "lyricsAvailable": !self.lyrics.is_empty()})
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeckSnapshot {
    pub deck: u8,
    pub song_key: Option<String>,
    pub loaded: bool,
    pub paused: bool,
    pub position_seconds: f64,
    pub sampled_at_unix_ms: u64,
    pub vocal_mode: String,
    pub playback_mode: String,
    pub volume: f64,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub decks: Vec<DeckSnapshot>,
    pub cue_active: bool,
    pub transition_busy: bool,
    pub runtime_ready: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Select {
        #[serde(rename = "songId")]
        song_id: String,
    },
    Play {},
    Pause {},
    Restart {},
    Next {
        #[serde(rename = "songId")]
        song_id: String,
    },
    VocalMode {
        mode: String,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub session_id: String,
    pub expected_revision: u64,
    pub issued_at_unix_ms: u64,
    pub operation: Operation,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    id: String,
    status: String,
    error: Option<String>,
    revision: u64,
}
struct Entry {
    command: Command,
    receipt: Receipt,
    admitted: Instant,
}
struct Inner {
    config: Config,
    config_path: Option<PathBuf>,
    running: bool,
    error: Option<String>,
    session_id: String,
    revision: u64,
    snapshot: Snapshot,
    fingerprint: String,
    updated: Option<Instant>,
    catalog: Vec<Song>,
    entries: VecDeque<Entry>,
}
struct Shared {
    inner: Mutex<Inner>,
    lifecycle: AsyncMutex<()>,
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
#[derive(Clone)]
pub struct SingerGateway(Arc<Shared>);
impl Default for SingerGateway {
    fn default() -> Self {
        Self(Arc::new(Shared {
            inner: Mutex::new(Inner {
                config: Config::default(),
                config_path: None,
                running: false,
                error: None,
                session_id: new_id(),
                revision: 0,
                snapshot: Snapshot::default(),
                fingerprint: String::new(),
                updated: None,
                catalog: vec![],
                entries: VecDeque::new(),
            }),
            lifecycle: AsyncMutex::new(()),
            server: Mutex::new(None),
        }))
    }
}

impl Inner {
    fn fresh(&self) -> bool {
        self.updated
            .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
            && self.snapshot.runtime_ready
    }
    fn expire(&mut self) {
        for entry in &mut self.entries {
            if entry.receipt.status == "queued" && entry.admitted.elapsed() > Duration::from_secs(5)
            {
                entry.receipt.status = "expired".into();
                entry.receipt.error = Some("command_expired".into());
            }
        }
    }
    fn cancel_queued(&mut self) {
        for entry in &mut self.entries {
            if entry.receipt.status == "queued" {
                entry.receipt.status = "cancelled".into();
            }
        }
    }
}

impl SingerGateway {
    pub async fn initialize(&self, path: PathBuf) -> Result<(), String> {
        let config = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            Config::default()
        };
        self.0.inner.lock().unwrap().config_path = Some(path);
        self.configure(config).await.map(|_| ())
    }
    pub fn status(&self) -> Value {
        let inner = self.0.inner.lock().unwrap();
        let mut addresses = vec![format!("http://127.0.0.1:{}", inner.config.port)];
        if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
            for (_, ip) in interfaces {
                if matches!(ip, IpAddr::V4(v) if v.is_private()) {
                    let address = format!("http://{}:{}", ip, inner.config.port);
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
            }
        }
        json!({"config": inner.config, "running": inner.running, "error": inner.error,
            "addresses": addresses, "controllerOnline": inner.fresh(), "songCount": inner.catalog.len()})
    }
    pub async fn configure(&self, config: Config) -> Result<Value, String> {
        if config.port < 1024
            || ![1, 2].contains(&config.deck)
            || config.token.len() != 64
            || !config.token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("无效端口、Deck 或连接密钥".into());
        }
        let _lifecycle = self.0.lifecycle.lock().await;
        {
            let mut inner = self.0.inner.lock().unwrap();
            if inner
                .entries
                .iter()
                .any(|e| e.receipt.status == "executing")
            {
                return Err("等待当前主唱操作返回结果后再修改连接设置".into());
            }
            inner.config.enabled = false;
            inner.running = false;
            inner.cancel_queued();
        }
        let previous = self.0.server.lock().unwrap().take();
        if let Some(task) = previous {
            task.abort();
            let _ = task.await;
        }
        let listener = if config.enabled {
            match tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, config.port))
                .await
            {
                Ok(listener) => Some(listener),
                Err(e) => {
                    self.0.inner.lock().unwrap().error = Some(e.to_string());
                    return Err(e.to_string());
                }
            }
        } else {
            None
        };
        {
            let mut inner = self.0.inner.lock().unwrap();
            if let Some(path) = &inner.config_path {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(
                    path,
                    serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            }
            inner.config = config;
            inner.error = None;
            inner.running = listener.is_some();
            inner.session_id = new_id();
            inner.revision += 1;
            inner.entries.clear();
        }
        if let Some(listener) = listener {
            let gateway = self.clone();
            let task = tokio::spawn(async move {
                let result = axum::serve(
                    listener,
                    router(gateway.clone()).into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await;
                let mut inner = gateway.0.inner.lock().unwrap();
                inner.running = false;
                inner.error = result.err().map(|e| e.to_string());
            });
            *self.0.server.lock().unwrap() = Some(task);
        }
        Ok(self.status())
    }
    pub fn set_catalog(&self, songs: Vec<Song>) -> Result<(), String> {
        if songs.len() > 100_000
            || songs.iter().any(|s| {
                s.key.is_empty() || !s.duration_seconds.is_finite() || s.lyrics.len() > 20_000
            })
        {
            return Err("曲库数据无效".into());
        }
        let mut inner = self.0.inner.lock().unwrap();
        inner.catalog = songs;
        inner.revision += 1;
        Ok(())
    }
    pub fn exchange(&self, snapshot: Snapshot) -> Value {
        let fingerprint = serde_json::to_string(&json!({"decks": snapshot.decks.iter().map(|d|
            json!([d.deck, d.song_key, d.loaded, d.paused, d.vocal_mode, d.playback_mode, d.volume.round()])).collect::<Vec<_>>(),
            "cue": snapshot.cue_active, "transition": snapshot.transition_busy, "ready": snapshot.runtime_ready})).unwrap();
        let mut inner = self.0.inner.lock().unwrap();
        if inner.fingerprint != fingerprint {
            inner.fingerprint = fingerprint;
            inner.revision += 1;
        }
        inner.snapshot = snapshot;
        inner.updated = Some(Instant::now());
        inner.expire();
        let revision = inner.revision;
        let deck = inner.config.deck;
        let mut work = Value::Null;
        if inner.config.enabled && inner.running && inner.fresh() {
            let index = inner
                .entries
                .iter()
                .position(|e| e.receipt.status == "queued");
            if let Some(index) = index {
                let command = inner.entries[index].command.clone();
                if command.expected_revision != revision {
                    inner.entries[index].receipt.status = "rejected".into();
                    inner.entries[index].receipt.error = Some("state_changed".into());
                } else {
                    let song_key = match &command.operation {
                        Operation::Select { song_id } | Operation::Next { song_id } => inner
                            .catalog
                            .iter()
                            .find(|s| s.id() == *song_id)
                            .map(|s| s.key.clone()),
                        _ => None,
                    };
                    inner.entries[index].receipt.status = "executing".into();
                    work = json!({"command": command, "deck": deck, "songKey": song_key});
                }
            }
        }
        json!({"enabled": inner.config.enabled, "deck": deck, "work": work})
    }
    pub fn complete(&self, id: &str, error: Option<String>) -> Result<(), String> {
        let mut inner = self.0.inner.lock().unwrap();
        inner.revision += 1;
        let revision = inner.revision;
        let entry = inner
            .entries
            .iter_mut()
            .find(|e| e.command.id == id && e.receipt.status == "executing")
            .ok_or("command_not_executing")?;
        entry.receipt.status = if error.is_some() {
            "failed"
        } else {
            "succeeded"
        }
        .into();
        // Desktop error text may contain filesystem paths; the public receipt is a code only.
        entry.receipt.error = error.map(|message| {
            let code = message.strip_prefix("Error: ").unwrap_or(&message);
            if [
                "player_unavailable",
                "cue_active",
                "desktop_mix_active",
                "song_not_found",
                "no_song_selected",
                "accompaniment_unavailable",
                "controller_reloaded",
                "controller_busy",
            ]
            .contains(&code)
            {
                code.into()
            } else {
                "playback_operation_failed".into()
            }
        });
        entry.receipt.revision = revision;
        Ok(())
    }
    fn submit(&self, command: Command) -> Result<Receipt, ApiError> {
        let mut inner = self.0.inner.lock().unwrap();
        inner.expire();
        if let Some(entry) = inner.entries.iter().find(|e| e.command.id == command.id) {
            return if entry.command == command {
                Ok(entry.receipt.clone())
            } else {
                Err(ApiError(StatusCode::CONFLICT, "id_reused"))
            };
        }
        if command.id.len() < 8
            || command.id.len() > 80
            || !command
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_id"));
        }
        if command.session_id != inner.session_id || command.expected_revision != inner.revision {
            return Err(ApiError(StatusCode::CONFLICT, "state_changed"));
        }
        if now_ms().abs_diff(command.issued_at_unix_ms) > 5_000 {
            return Err(ApiError(StatusCode::CONFLICT, "command_expired"));
        }
        if !inner.fresh() {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "controller_offline",
            ));
        }
        if inner
            .entries
            .iter()
            .any(|e| matches!(e.receipt.status.as_str(), "queued" | "executing"))
        {
            return Err(ApiError(StatusCode::CONFLICT, "controller_busy"));
        }
        match &command.operation {
            Operation::Select { song_id } | Operation::Next { song_id }
                if !inner.catalog.iter().any(|s| s.id() == *song_id) =>
            {
                return Err(ApiError(StatusCode::NOT_FOUND, "song_not_found"))
            }
            Operation::VocalMode { mode }
                if !["original", "accompaniment"].contains(&mode.as_str()) =>
            {
                return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_vocal_mode"))
            }
            _ => {}
        }
        let receipt = Receipt {
            id: command.id.clone(),
            status: "queued".into(),
            error: None,
            revision: inner.revision,
        };
        if inner.entries.len() >= 128 {
            inner.entries.pop_front();
        }
        inner.entries.push_back(Entry {
            command,
            receipt: receipt.clone(),
            admitted: Instant::now(),
        });
        Ok(receipt)
    }
}

#[derive(Debug)]
struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
async fn guard(State(gateway): State<SingerGateway>, request: Request, next: Next) -> Response {
    let allowed_peer = request.extensions().get::<ConnectInfo<SocketAddr>>().is_some_and(|ConnectInfo(peer)|
        matches!(peer.ip(), IpAddr::V4(ip) if ip.is_private() || ip.is_loopback()));
    if !allowed_peer {
        return ApiError(StatusCode::FORBIDDEN, "lan_only").into_response();
    }
    // A separate native tablet client uses Bearer authentication. Browser callers
    // need an explicitly designed same-origin gateway; do not enable wildcard CORS.
    if request.headers().contains_key(header::ORIGIN) {
        return ApiError(StatusCode::FORBIDDEN, "browser_origin_not_enabled").into_response();
    }
    let authorized = {
        let inner = gateway.0.inner.lock().unwrap();
        let supplied = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or("");
        let expected = inner.config.token.as_bytes();
        inner.config.enabled
            && supplied.len() == expected.len()
            && supplied
                .bytes()
                .zip(expected)
                .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                == 0
    };
    if !authorized {
        return ApiError(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let result = tokio::time::timeout(Duration::from_secs(3), next.run(request)).await;
    let mut response = result.unwrap_or_else(|_| {
        ApiError(StatusCode::REQUEST_TIMEOUT, "request_timeout").into_response()
    });
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
pub fn router(gateway: SingerGateway) -> Router {
    Router::new()
        .route("/api/singer/v1/state", get(state))
        .route("/api/singer/v1/songs", get(songs))
        .route("/api/singer/v1/songs/{id}/lyrics", get(lyrics))
        .route("/api/singer/v1/commands", post(command))
        .route("/api/singer/v1/commands/{id}", get(receipt))
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::from_fn_with_state(gateway.clone(), guard))
        .with_state(gateway)
}
async fn state(State(gateway): State<SingerGateway>) -> Json<Value> {
    let mut inner = gateway.0.inner.lock().unwrap();
    inner.expire();
    let deck = inner
        .snapshot
        .decks
        .iter()
        .find(|d| d.deck == inner.config.deck);
    let song = deck
        .and_then(|d| d.song_key.as_ref())
        .and_then(|key| inner.catalog.iter().find(|s| s.key == *key));
    Json(
        json!({"apiVersion": 1, "sessionId": inner.session_id, "revision": inner.revision,
        "serverTimeUnixMs": now_ms(), "controllerOnline": inner.fresh(), "deck": inner.config.deck,
        "song": song.map(Song::summary), "playback": deck.map(|d| json!({"loaded": d.loaded, "paused": d.paused,
            "positionSeconds": d.position_seconds, "sampledAtUnixMs": d.sampled_at_unix_ms, "vocalMode": d.vocal_mode,
            "playbackMode": d.playback_mode, "volume": d.volume,
            "clockFresh": inner.fresh() && now_ms().abs_diff(d.sampled_at_unix_ms) < 2000})),
        "cueActive": inner.snapshot.cue_active, "transitionBusy": inner.snapshot.transition_busy,
        "busy": inner.entries.iter().any(|e| matches!(e.receipt.status.as_str(), "queued" | "executing"))}),
    )
}
#[derive(Deserialize)]
struct Search {
    q: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}
async fn songs(State(gateway): State<SingerGateway>, Query(search): Query<Search>) -> Json<Value> {
    let inner = gateway.0.inner.lock().unwrap();
    let needle = search
        .q
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect::<String>()
        .to_lowercase();
    let matches: Vec<_> = inner
        .catalog
        .iter()
        .filter(|s| {
            format!("{} {}", s.title, s.artist)
                .to_lowercase()
                .contains(&needle)
        })
        .collect();
    let offset = search.offset.unwrap_or(0);
    let limit = search.limit.unwrap_or(50).clamp(1, 100);
    Json(
        json!({"total": matches.len(), "offset": offset, "limit": limit,
        "items": matches.into_iter().skip(offset).take(limit).map(Song::summary).collect::<Vec<_>>()}),
    )
}
async fn lyrics(
    State(gateway): State<SingerGateway>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let inner = gateway.0.inner.lock().unwrap();
    let song = inner
        .catalog
        .iter()
        .find(|s| s.id() == id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "song_not_found"))?;
    Ok(Json(
        json!({"songId": id, "lines": song.lyrics, "timing": "line", "clock": "mpv"}),
    ))
}
async fn command(
    State(gateway): State<SingerGateway>,
    payload: Result<Json<Command>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<Receipt>), ApiError> {
    let Json(command) = payload.map_err(|error| ApiError(error.status(), "invalid_command"))?;
    gateway
        .submit(command)
        .map(|r| (StatusCode::ACCEPTED, Json(r)))
}
async fn receipt(
    State(gateway): State<SingerGateway>,
    Path(id): Path<String>,
) -> Result<Json<Receipt>, ApiError> {
    let mut inner = gateway.0.inner.lock().unwrap();
    inner.expire();
    inner
        .entries
        .iter()
        .find(|e| e.command.id == id)
        .map(|e| Json(e.receipt.clone()))
        .ok_or(ApiError(StatusCode::NOT_FOUND, "receipt_not_found"))
}

#[tauri::command]
pub fn singer_gateway_status(state: tauri::State<'_, SingerGateway>) -> Value {
    state.status()
}
#[tauri::command]
pub async fn singer_gateway_configure(
    state: tauri::State<'_, SingerGateway>,
    enabled: bool,
    port: u16,
    deck: u8,
    rotate_token: bool,
) -> Result<Value, String> {
    let mut config = state.0.inner.lock().unwrap().config.clone();
    config.enabled = enabled;
    config.port = port;
    config.deck = deck;
    if rotate_token {
        config.token = new_id() + &new_id();
    }
    state.configure(config).await
}
#[tauri::command]
pub fn singer_gateway_catalog(
    state: tauri::State<'_, SingerGateway>,
    songs: Vec<Song>,
) -> Result<(), String> {
    state.set_catalog(songs)
}
#[tauri::command]
pub fn singer_gateway_exchange(
    state: tauri::State<'_, SingerGateway>,
    snapshot: Snapshot,
) -> Value {
    state.exchange(snapshot)
}
#[tauri::command]
pub fn singer_gateway_complete(
    state: tauri::State<'_, SingerGateway>,
    id: String,
    error: Option<String>,
    snapshot: Snapshot,
) -> Result<(), String> {
    state.exchange(snapshot);
    state.complete(&id, error)
}

pub fn start_saved(app: &tauri::AppHandle) {
    let gateway = app.state::<SingerGateway>().inner().clone();
    let path = match app.path().app_data_dir() {
        Ok(path) => path.join("singer-gateway.json"),
        Err(_) => return,
    };
    tauri::async_runtime::spawn(async move {
        if let Err(error) = gateway.initialize(path).await {
            gateway.0.inner.lock().unwrap().error = Some(error.clone());
            eprintln!("Singer gateway startup: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn fixture() -> SingerGateway {
        let gateway = SingerGateway::default();
        {
            let mut inner = gateway.0.inner.lock().unwrap();
            inner.config.enabled = true;
            inner.running = true;
        }
        gateway
            .set_catalog(vec![Song {
                key: "D:/private/song.flac".into(),
                title: "晴天".into(),
                artist: "测试歌手".into(),
                duration_seconds: 180.0,
                accompaniment_available: true,
                lyrics: vec![json!({"atSeconds":1.0,"text":"第一句"})],
            }])
            .unwrap();
        gateway.exchange(snapshot());
        gateway
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            runtime_ready: true,
            decks: vec![DeckSnapshot {
                deck: 1,
                song_key: Some("D:/private/song.flac".into()),
                loaded: true,
                paused: true,
                position_seconds: 12.5,
                sampled_at_unix_ms: now_ms(),
                vocal_mode: "original".into(),
                playback_mode: "single".into(),
                volume: 66.0,
            }],
            ..Default::default()
        }
    }
    fn make_command(gateway: &SingerGateway) -> Command {
        let inner = gateway.0.inner.lock().unwrap();
        Command {
            id: new_id(),
            session_id: inner.session_id.clone(),
            expected_revision: inner.revision,
            issued_at_unix_ms: now_ms(),
            operation: Operation::Restart {},
        }
    }
    fn request(gateway: &SingerGateway, method: &str, url: &str, body: Value) -> Request {
        let token = gateway.0.inner.lock().unwrap().config.token.clone();
        let mut request = Request::builder()
            .method(method)
            .uri(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:51234".parse::<SocketAddr>().unwrap(),
        ));
        request
    }
    async fn body(response: Response) -> Value {
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[tokio::test]
    async fn protocol_requires_key_and_rejects_browser_and_public_network() {
        let gateway = fixture();
        let mut missing = request(&gateway, "GET", "/api/singer/v1/state", Value::Null);
        missing.headers_mut().remove(header::AUTHORIZATION);
        assert_eq!(
            router(gateway.clone())
                .oneshot(missing)
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut browser = request(&gateway, "GET", "/api/singer/v1/state", Value::Null);
        browser
            .headers_mut()
            .insert(header::ORIGIN, "https://example.com".parse().unwrap());
        assert_eq!(
            router(gateway.clone())
                .oneshot(browser)
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let mut public = request(&gateway, "GET", "/api/singer/v1/state", Value::Null);
        public.extensions_mut().insert(ConnectInfo(
            "203.0.113.10:5000".parse::<SocketAddr>().unwrap(),
        ));
        assert_eq!(
            router(gateway.clone())
                .oneshot(public)
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn public_catalog_and_clock_never_expose_local_paths_or_key() {
        let gateway = fixture();
        for url in [
            "/api/singer/v1/state",
            "/api/singer/v1/songs?q=%E6%99%B4&limit=1",
        ] {
            let response = router(gateway.clone())
                .oneshot(request(&gateway, "GET", url, Value::Null))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let value = body(response).await;
            assert!(!value.to_string().contains("private"));
            assert!(!value.to_string().contains("token"));
            if url.ends_with("state") {
                assert_eq!(value["playback"]["positionSeconds"], 12.5);
                assert_eq!(value["playback"]["clockFresh"], true);
            } else {
                assert_eq!(value["total"], 1);
                assert_eq!(value["items"].as_array().unwrap().len(), 1);
            }
        }
        let id = gateway.0.inner.lock().unwrap().catalog[0].id();
        let response = router(gateway.clone())
            .oneshot(request(
                &gateway,
                "GET",
                &format!("/api/singer/v1/songs/{id}/lyrics"),
                Value::Null,
            ))
            .await
            .unwrap();
        assert_eq!(body(response).await["lines"][0]["text"], "第一句");
    }
    #[test]
    fn duplicate_request_is_claimed_exactly_once_and_receipt_is_reused() {
        let gateway = fixture();
        let command = make_command(&gateway);
        assert_eq!(gateway.submit(command.clone()).unwrap().status, "queued");
        assert_eq!(gateway.submit(command.clone()).unwrap().status, "queued");
        assert_eq!(
            gateway.exchange(snapshot())["work"]["command"]["id"],
            command.id
        );
        assert!(gateway.exchange(snapshot())["work"].is_null());
        gateway.complete(&command.id, None).unwrap();
        assert_eq!(gateway.submit(command.clone()).unwrap().status, "succeeded");
        let mut different = command;
        different.operation = Operation::Play {};
        assert_eq!(gateway.submit(different).err().unwrap().1, "id_reused");
    }
    #[test]
    fn stale_sessions_revisions_and_request_times_do_not_execute() {
        let gateway = fixture();
        let mut command = make_command(&gateway);
        command.session_id = "old".into();
        assert_eq!(gateway.submit(command).err().unwrap().1, "state_changed");
        let mut command = make_command(&gateway);
        command.expected_revision = 0;
        assert_eq!(gateway.submit(command).err().unwrap().1, "state_changed");
        let mut command = make_command(&gateway);
        command.issued_at_unix_ms = now_ms() - 6000;
        assert_eq!(gateway.submit(command).err().unwrap().1, "command_expired");
        assert!(gateway.exchange(snapshot())["work"].is_null());
    }
    #[test]
    fn concurrent_commands_are_bounded_and_offline_controller_fails_closed() {
        let gateway = fixture();
        gateway.submit(make_command(&gateway)).unwrap();
        assert_eq!(
            gateway.submit(make_command(&gateway)).err().unwrap().1,
            "controller_busy"
        );
        let gateway = fixture();
        gateway.0.inner.lock().unwrap().updated = Some(Instant::now() - Duration::from_secs(3));
        assert_eq!(
            gateway.submit(make_command(&gateway)).err().unwrap().1,
            "controller_offline"
        );
    }
    #[test]
    fn local_song_change_invalidates_queued_request_before_claim() {
        let gateway = fixture();
        let command = make_command(&gateway);
        gateway.submit(command.clone()).unwrap();
        let mut next = snapshot();
        next.decks[0].song_key = Some("another".into());
        assert!(gateway.exchange(next)["work"].is_null());
        assert_eq!(gateway.submit(command).unwrap().status, "rejected");
    }
    #[test]
    fn queue_expiry_and_player_failure_never_report_success() {
        let gateway = fixture();
        let command = make_command(&gateway);
        gateway.submit(command.clone()).unwrap();
        gateway.0.inner.lock().unwrap().entries[0].admitted =
            Instant::now() - Duration::from_secs(6);
        assert!(gateway.exchange(snapshot())["work"].is_null());
        assert_eq!(gateway.submit(command).unwrap().status, "expired");
        let command = make_command(&gateway);
        gateway.submit(command.clone()).unwrap();
        gateway.exchange(snapshot());
        gateway
            .complete(&command.id, Some("D:/private/file pipe_timeout".into()))
            .unwrap();
        let receipt = gateway.submit(command).unwrap();
        assert_eq!(receipt.status, "failed");
        assert_eq!(receipt.error.as_deref(), Some("playback_operation_failed"));
    }
    #[tokio::test]
    async fn malformed_and_non_allowlisted_commands_are_rejected() {
        let gateway = fixture();
        for operation in [
            json!({"type":"shell","command":"anything"}),
            json!({"type":"next"}),
            json!({"type":"play","path":"C:/secret"}),
        ] {
            let mut command = serde_json::to_value(make_command(&gateway)).unwrap();
            command["operation"] = operation;
            let response = router(gateway.clone())
                .oneshot(request(
                    &gateway,
                    "POST",
                    "/api/singer/v1/commands",
                    command,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        assert!(gateway.exchange(snapshot())["work"].is_null());
    }
    #[tokio::test]
    async fn disabled_and_rotated_keys_are_rejected() {
        let gateway = fixture();
        let old = request(&gateway, "GET", "/api/singer/v1/state", Value::Null);
        gateway.0.inner.lock().unwrap().config.token = new_id() + &new_id();
        assert_eq!(
            router(gateway.clone()).oneshot(old).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let old = request(&gateway, "GET", "/api/singer/v1/state", Value::Null);
        gateway.0.inner.lock().unwrap().config.enabled = false;
        assert_eq!(
            router(gateway.clone()).oneshot(old).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn real_tcp_listener_serves_authenticated_state() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let gateway = fixture();
        let token = gateway.0.inner.lock().unwrap().config.token.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router(gateway).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(format!("GET /api/singer/v1/state HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut bytes = vec![];
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(bytes).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("\"positionSeconds\":12.5"));
        server.abort();
    }
}
