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
#[path = "singer_pairing.rs"]
mod pairing;

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
    #[serde(default = "new_id")]
    pub controller_id: String,
    #[serde(default)]
    pub audio_policy: AudioPolicy,
    pub enabled: bool,
    pub port: u16,
    pub deck: u8,
    pub token: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            controller_id: new_id(),
            audio_policy: AudioPolicy::default(),
            enabled: false,
            port: 4865,
            deck: 1,
            token: new_id() + &new_id(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioPolicy {
    pub microphone: String,
    #[serde(default)] pub microphone2: String,
    pub reverb_bus: String,
    pub music_max: u8,
    pub microphone_max: u8,
    #[serde(default = "default_microphone_max")] pub microphone2_max: u8,
    pub reverb_max: u8,
}
fn default_microphone_max() -> u8 { 77 }
impl Default for AudioPolicy {
    fn default() -> Self {
        Self { microphone: String::new(), microphone2: String::new(), reverb_bus: String::new(), music_max: 100, microphone_max: 77, microphone2_max: 77, reverb_max: 60 }
    }
}
impl AudioPolicy {
    fn valid(&self) -> bool {
        ["", "ch-1", "ch-2", "ch-6"].contains(&self.microphone.as_str())
            && ["", "ch-1", "ch-2", "ch-6"].contains(&self.microphone2.as_str())
            && (self.microphone2.is_empty() || self.microphone2 != self.microphone)
            && ["", "FX 1", "FX 2"].contains(&self.reverb_bus.as_str())
            && self.music_max <= 100 && self.microphone_max <= 77 && self.microphone2_max <= 77 && self.reverb_max <= 77
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioLevel {
    pub available: bool,
    pub value: Option<u8>,
    pub reason: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioSnapshot {
    pub music: AudioLevel,
    pub microphone: AudioLevel,
    #[serde(default)] pub microphone2: AudioLevel,
    pub reverb: AudioLevel,
    pub acappella: bool,
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Playlist {
    pub key: String,
    pub name: String,
    pub kind: String,
    pub library: u8,
    pub song_keys: Vec<String>,
}
impl Playlist {
    fn id(&self) -> String { blake3::hash(self.key.as_bytes()).to_hex().to_string() }
    fn summary(&self) -> Value {
        json!({"id":self.id(),"name":self.name,"kind":self.kind,"library":self.library,"count":self.song_keys.len()})
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeckSnapshot {
    #[serde(default)] pub pitch_semitones: i8,
    #[serde(default)] pub playlist_key: Option<String>,
    #[serde(default)] pub return_song_key: Option<String>,
    #[serde(default)] pub return_position_seconds: Option<f64>,
    #[serde(default)] pub return_revision: u64,
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
    #[serde(default)]
    pub front_light: Value,
    #[serde(default)]
    pub auto_return_next: bool,
    #[serde(default)]
    pub audio: AudioSnapshot,
    pub decks: Vec<DeckSnapshot>,
    pub cue_active: bool,
    pub transition_busy: bool,
    pub runtime_ready: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    FrontLight { enabled: bool },
    AutoReturnNext { enabled: bool },
    Atmosphere { effect: String, volume: u8 },
    Pitch { semitones: i8 },
    TemporarySelect { #[serde(rename="songId")] song_id: String },
    PlaylistSelect { #[serde(rename="songId")] song_id: String, #[serde(rename="playlistId")] playlist_id: String },
    Select {
        #[serde(rename = "songId")]
        song_id: String,
    },
    AudioLevel { control: String, value: u8 },
    Acappella { enabled: bool },
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
    pairing: Option<pairing::PairingWindow>,
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
    playlists: Vec<Playlist>,
    entries: VecDeque<Entry>,
}
struct Shared {
    discovery: Mutex<Option<tokio::task::JoinHandle<()>>>,
    inner: Mutex<Inner>,
    lifecycle: AsyncMutex<()>,
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
#[derive(Clone)]
pub struct SingerGateway(Arc<Shared>);
impl Default for SingerGateway {
    fn default() -> Self {
        Self(Arc::new(Shared {
            discovery: Mutex::new(None),
            inner: Mutex::new(Inner {
                pairing: None,
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
                playlists: vec![],
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
            "pairing": inner.pairing.as_ref().map(pairing::PairingWindow::status),
            "addresses": addresses, "controllerOnline": inner.fresh(), "songCount": inner.catalog.len()})
    }
    pub async fn configure(&self, config: Config) -> Result<Value, String> {
        if config.controller_id.len() != 32 || !config.controller_id.bytes().all(|b| b.is_ascii_hexdigit()) || !config.audio_policy.valid() || config.port < 1024
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
            inner.pairing = None;
        }
        if let Some(task) = self.0.discovery.lock().unwrap().take() { task.abort(); }
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
            pairing::start_discovery(self).await;
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
    pub fn set_playlists(&self, playlists: Vec<Playlist>) -> Result<(), String> {
        if playlists.len()>1000 || playlists.iter().any(|p| p.key.is_empty() || ![1,2].contains(&p.library) || p.song_keys.len()>100_000) {
            return Err("歌单数据无效".into());
        }
        let mut inner=self.0.inner.lock().unwrap();
        inner.playlists=playlists; inner.revision+=1; Ok(())
    }
    pub fn exchange(&self, snapshot: Snapshot) -> Value {
        let fingerprint = serde_json::to_string(&json!({"decks": snapshot.decks.iter().map(|d|
            json!([d.deck, d.song_key, d.loaded, d.paused, d.vocal_mode, d.playback_mode, d.volume.round(), d.pitch_semitones, d.playlist_key, d.return_song_key, d.return_revision])).collect::<Vec<_>>(),
            "frontLight": snapshot.front_light, "audio": snapshot.audio, "autoReturnNext": snapshot.auto_return_next, "cue": snapshot.cue_active, "transition": snapshot.transition_busy, "ready": snapshot.runtime_ready})).unwrap();
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
                        Operation::Select { song_id } | Operation::Next { song_id } | Operation::TemporarySelect { song_id } | Operation::PlaylistSelect { song_id, .. } => inner
                            .catalog
                            .iter()
                            .find(|s| s.id() == *song_id)
                            .map(|s| s.key.clone()),
                        _ => None,
                    };
                    let playlist_key = match &command.operation {
                        Operation::PlaylistSelect { playlist_id, .. } => inner.playlists.iter().find(|p| p.id()==*playlist_id).map(|p|p.key.clone()),
                        _=>None,
                    };
                    inner.entries[index].receipt.status = "executing".into();
                    work = json!({"command": command, "deck": deck, "songKey": song_key, "playlistKey":playlist_key, "audioPolicy": inner.config.audio_policy});
                }
            }
        }
        json!({"enabled": inner.config.enabled, "deck": deck, "work": work, "audioPolicy": inner.config.audio_policy})
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
                "invalid_pitch", "pitch_readback_failed", "playlist_not_found", "song_not_in_playlist", "return_song_unavailable", "invalid_audio_value", "audio_unbound", "mixer_unavailable", "audio_readback_pending",
                "audio_unavailable", "audio_readback_failed", "acappella_active",
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
            Operation::FrontLight { .. } if inner.snapshot.front_light["available"] != true => return Err(ApiError(StatusCode::CONFLICT,"front_light_unavailable")),
            Operation::Atmosphere { effect, volume } if !["applause","cheer","scream","stop"].contains(&effect.as_str()) || *volume>60 => return Err(ApiError(StatusCode::BAD_REQUEST,"invalid_effect")),
            Operation::Pitch { semitones } if !(-6..=6).contains(semitones) => return Err(ApiError(StatusCode::BAD_REQUEST,"invalid_pitch")),
            Operation::PlaylistSelect { song_id, playlist_id } => {
                let playlist=inner.playlists.iter().find(|p|p.id()==*playlist_id).ok_or(ApiError(StatusCode::NOT_FOUND,"playlist_not_found"))?;
                if !playlist.song_keys.iter().any(|key|blake3::hash(key.as_bytes()).to_hex().to_string()==*song_id) {
                    return Err(ApiError(StatusCode::CONFLICT,"song_not_in_playlist"));
                }
            }
            _=>{}
        }
        let policy = &inner.config.audio_policy;
        let audio = &inner.snapshot.audio;
        match &command.operation {
            Operation::AudioLevel { control, value } => {
                let (level, max, bound) = match control.as_str() {
                    "music" => (&audio.music, policy.music_max, true),
                    "microphone" => (&audio.microphone, policy.microphone_max, !policy.microphone.is_empty()),
                    "microphone2" => (&audio.microphone2, policy.microphone2_max, !policy.microphone2.is_empty()),
                    "reverb" => (&audio.reverb, policy.reverb_max, !policy.microphone.is_empty() && !policy.reverb_bus.is_empty()),
                    _ => return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_audio_value")),
                };
                if *value > max { return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_audio_value")); }
                if !bound { return Err(ApiError(StatusCode::CONFLICT, "audio_unbound")); }
                if !level.available { return Err(ApiError(StatusCode::CONFLICT, "audio_unavailable")); }
                if control == "music" && audio.acappella { return Err(ApiError(StatusCode::CONFLICT, "acappella_active")); }
            }
            Operation::Acappella { .. } if !audio.music.available => {
                return Err(ApiError(StatusCode::CONFLICT, "audio_unavailable"));
            }
            _ => {}
        }
        match &command.operation {
            Operation::Select { song_id } | Operation::Next { song_id } | Operation::TemporarySelect { song_id } | Operation::PlaylistSelect { song_id, .. }
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
    let pairing_request = (request.method() == axum::http::Method::POST && request.uri().path() == "/api/singer/v1/pair") || (request.method() == axum::http::Method::GET && request.uri().path() == "/api/singer/v1/info");
    if !authorized && !pairing_request {
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
        .route("/api/singer/v1/pair", post(pairing::pair))
        .route("/api/singer/v1/info", get(pairing::info))
        .route("/api/singer/v1/state", get(state))
        .route("/api/singer/v1/songs", get(songs))
        .route("/api/singer/v1/playlists", get(playlists))
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
        "controllerId": inner.config.controller_id,
        "serverTimeUnixMs": now_ms(), "controllerOnline": inner.fresh(), "deck": inner.config.deck,
        "song": song.map(Song::summary), "playback": deck.map(|d| json!({"loaded": d.loaded, "paused": d.paused,
            "positionSeconds": d.position_seconds, "sampledAtUnixMs": d.sampled_at_unix_ms, "vocalMode": d.vocal_mode,
            "playbackMode": d.playback_mode, "volume": d.volume, "pitchSemitones": d.pitch_semitones,
            "clockFresh": inner.fresh() && now_ms().abs_diff(d.sampled_at_unix_ms) < 2000})),
        "frontLight":inner.snapshot.front_light,
        "features":{"frontLight":true,"pitch":true,"playlists":true,"temporarySelect":true,"autoReturnNext":true,"atmosphere":true},
        "autoReturnNext":inner.snapshot.auto_return_next,
        "playlist":deck.and_then(|d|d.playlist_key.as_ref()).and_then(|key|inner.playlists.iter().find(|p|p.key==*key)).map(Playlist::summary),
        "interlude":deck.map(|d|json!({"active":d.return_song_key.is_some(),"returnSong":d.return_song_key.as_ref().and_then(|key|inner.catalog.iter().find(|s|s.key==*key)).map(Song::summary),"returnPositionSeconds":d.return_position_seconds,"returnRevision":d.return_revision})),
        "audio": inner.snapshot.audio, "audioPolicy": inner.config.audio_policy,
        "cueActive": inner.snapshot.cue_active, "transitionBusy": inner.snapshot.transition_busy,
        "busy": inner.entries.iter().any(|e| matches!(e.receipt.status.as_str(), "queued" | "executing"))}),
    )
}
#[derive(Deserialize)]
struct Search {
    q: Option<String>,
    #[serde(rename="playlistId")] playlist_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}
async fn playlists(State(gateway): State<SingerGateway>) -> Json<Value> {
    let inner=gateway.0.inner.lock().unwrap();
    Json(json!({"items":inner.playlists.iter().map(Playlist::summary).collect::<Vec<_>>()}))
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
    let selected=search.playlist_id.as_ref().and_then(|id|inner.playlists.iter().find(|p|p.id()==*id));
    let ordered:Vec<_>=if let Some(playlist)=selected {
        playlist.song_keys.iter().filter_map(|key|inner.catalog.iter().find(|s|s.key==*key)).collect()
    } else if search.playlist_id.is_some() { vec![] } else { inner.catalog.iter().collect() };
    let matches: Vec<_> = ordered.into_iter()
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
pub fn singer_gateway_pairing(state: tauri::State<'_, SingerGateway>, enabled: bool) -> Result<Value, String> {
    pairing::set_window(&state, enabled)?;
    Ok(state.status())
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
    audio_policy: Option<AudioPolicy>,
) -> Result<Value, String> {
    let mut config = state.0.inner.lock().unwrap().config.clone();
    if let Some(policy) = audio_policy { config.audio_policy = policy; }
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
    playlists: Option<Vec<Playlist>>,
) -> Result<(), String> {
    state.set_catalog(songs)?;
    state.set_playlists(playlists.unwrap_or_default())
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
                ..DeckSnapshot::default()
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
    #[test]
    fn audio_requires_explicit_binding_and_enforces_limits_before_claim() {
        let gateway = fixture();
        let mut snap = snapshot();
        snap.audio.music = AudioLevel { available: true, value: Some(66), reason: None };
        snap.audio.microphone = AudioLevel { available: true, value: Some(60), reason: None };
        gateway.exchange(snap.clone());
        let mut command = make_command(&gateway);
        command.operation = Operation::AudioLevel { control: "microphone".into(), value: 60 };
        assert_eq!(gateway.submit(command.clone()).err().unwrap().1, "audio_unbound");
        gateway.0.inner.lock().unwrap().config.audio_policy.microphone = "ch-6".into();
        command.operation = Operation::AudioLevel { control: "microphone".into(), value: 78 };
        assert_eq!(gateway.submit(command.clone()).err().unwrap().1, "invalid_audio_value");
        command.operation = Operation::AudioLevel { control: "gain".into(), value: 30 };
        assert_eq!(gateway.submit(command.clone()).err().unwrap().1, "invalid_audio_value");
        command.operation = Operation::AudioLevel { control: "music".into(), value: 55 };
        assert_eq!(gateway.submit(command.clone()).unwrap().status, "queued");
        let work = gateway.exchange(snap);
        assert_eq!(work["work"]["command"]["operation"]["control"], "music");
        gateway.complete(&command.id, Some("Error: audio_readback_failed".into())).unwrap();
        let inner = gateway.0.inner.lock().unwrap();
        assert_eq!(inner.entries.back().unwrap().receipt.status, "failed");
        assert_eq!(inner.entries.back().unwrap().receipt.error.as_deref(), Some("audio_readback_failed"));
    }
    #[test]
    fn audio_defaults_and_wire_types_fail_closed() {
        let config: Config = serde_json::from_value(json!({"enabled":false,"port":4865,"deck":1,"token":"0".repeat(64)})).unwrap();
        assert!(config.audio_policy.microphone.is_empty());
        assert!(config.audio_policy.reverb_bus.is_empty());
        for op in [json!({"type":"audio_level","control":"music","value":-1}),
            json!({"type":"audio_level","control":"music","value":1.5}),
            json!({"type":"audio_level","control":"microphone","value":60,"target":"lr-master"}),
            json!({"type":"acappella","enabled":"true"})] {
            assert!(serde_json::from_value::<Operation>(op).is_err());
        }
        let mut policy = AudioPolicy::default();
        policy.microphone = "ch-11".into(); assert!(!policy.valid());
        policy.microphone = "ch-6".into(); policy.reverb_bus = "LR".into(); assert!(!policy.valid());
        policy.reverb_bus = "FX 1".into(); policy.microphone_max = 78; assert!(!policy.valid());
    }

    #[tokio::test]
    async fn playlists_preserve_order_hide_paths_and_validate_selection() {
        let gateway=fixture();
        let first=gateway.0.inner.lock().unwrap().catalog[0].clone();
        let second=Song{key:"D:/private/second.flac".into(),title:"Second".into(),..first.clone()};
        gateway.set_catalog(vec![first.clone(),second.clone()]).unwrap();
        let playlist=Playlist{key:"2:private-playlist-key".into(),name:"Singer".into(),kind:"custom".into(),library:2,song_keys:vec![second.key.clone(),first.key.clone()]};
        let id=playlist.id();gateway.set_playlists(vec![playlist]).unwrap();gateway.exchange(snapshot());
        let response=body(router(gateway.clone()).oneshot(request(&gateway,"GET","/api/singer/v1/playlists",json!(null))).await.unwrap()).await;
        assert_eq!(response["items"][0]["count"],2);assert!(!response.to_string().contains("private"));
        let path=format!("/api/singer/v1/songs?playlistId={id}");
        let response=body(router(gateway.clone()).oneshot(request(&gateway,"GET",&path,json!(null))).await.unwrap()).await;
        assert_eq!(response["items"][0]["id"],second.id());assert_eq!(response["items"][1]["id"],first.id());
        let mut command=make_command(&gateway);command.operation=Operation::PlaylistSelect{song_id:first.id(),playlist_id:"bad".into()};
        assert!(gateway.submit(command).is_err());
        let mut command=make_command(&gateway);command.operation=Operation::PlaylistSelect{song_id:first.id(),playlist_id:id};
        gateway.submit(command).unwrap();let work=gateway.exchange(snapshot());assert_eq!(work["work"]["songKey"],first.key);
        assert_eq!(work["work"]["playlistKey"],"2:private-playlist-key");
    }
    #[test]
    fn pitch_range_is_checked_at_admission() {
        let gateway=fixture();
        for semitones in [-7,7] {let mut command=make_command(&gateway);command.operation=Operation::Pitch{semitones};assert!(gateway.submit(command).is_err());}
        let mut command=make_command(&gateway);command.operation=Operation::Pitch{semitones:-2};assert!(gateway.submit(command).is_ok());
    }

}
