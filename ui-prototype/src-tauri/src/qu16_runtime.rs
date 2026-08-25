//! Allen & Heath Qu-16 TCP MIDI meter runtime.
//!
//! This module deliberately has no Tauri dependency. `Qu16Runtime::start_metering`
//! accepts a callback, so `lib.rs` can bridge snapshots to a Tauri event without
//! coupling the protocol worker to the application shell.
//!
//! Protocol source: Qu MIDI Protocol V1.9+ ISS.2, pages 10-12.
//! The first meter-layout heading on page 12 says "Qu-24", but the contents of
//! that column (16 mono inputs followed by 80 unused meters) are the Qu-16
//! layout. The second column is the actual Qu-24 layout.

use crate::qu16_control::{
    command_from_parameter_write, MidiMessage, MidiStreamDecoder, Qu16ControlCommand,
    Qu16ControlObservation, Qu16ControlObserver, Qu16ParameterWrite,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fmt,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const QU16_TCP_PORT: u16 = 51_325;
pub const QU16_METER_SOURCE: &str = "qu16-tcp-midi";
pub const METER_SILENCE_DBFS: f32 = -128.0;

const ACTIVE_SENSE: u8 = 0xFE;
#[cfg(test)]
const SYSEX_START: u8 = 0xF0;
const SYSEX_END: u8 = 0xF7;
const QU_SYSEX_PREFIX: [u8; 8] = [0xF0, 0x00, 0x00, 0x1A, 0x50, 0x11, 0x01, 0x00];
const ALL_CALL: u8 = 0x7F;
const COMMAND_GET_SYSTEM_STATE: u8 = 0x10;
const COMMAND_SYSTEM_STATE: u8 = 0x11;
const COMMAND_METER_REQUEST: u8 = 0x12;
const COMMAND_METER_DATA: u8 = 0x13;
const COMMAND_END_SYNC: u8 = 0x14;
const QU16_BOX_ID: u8 = 0x01;

const MONO_INPUT_BLOCK_METERS: usize = 10;
const STEREO_INPUT_BLOCK_METERS: usize = 20;
const MONO_MIX_BLOCK_METERS: usize = 10;
const STEREO_MIX_BLOCK_METERS: usize = 20;
const STEREO_MONITOR_BLOCK_METERS: usize = 78;
const STEREO_FX_BLOCK_METERS: usize = 18;

const QU16_MONO_INPUTS: usize = 16;
const QU16_UNUSED_AFTER_MONO_INPUTS: usize = 80;
const QU16_STEREO_INPUTS: usize = 3;
const QU16_UNUSED_AFTER_STEREO_INPUTS: usize = 20;
const QU16_MONO_MIXES: usize = 4;
const QU16_STEREO_MIXES: usize = 4;
const QU16_STEREO_FX: usize = 4;

pub const QU16_METER_VALUE_COUNT: usize = QU16_MONO_INPUTS * MONO_INPUT_BLOCK_METERS
    + QU16_UNUSED_AFTER_MONO_INPUTS
    + QU16_STEREO_INPUTS * STEREO_INPUT_BLOCK_METERS
    + QU16_UNUSED_AFTER_STEREO_INPUTS
    + QU16_MONO_MIXES * MONO_MIX_BLOCK_METERS
    + QU16_STEREO_MIXES * STEREO_MIX_BLOCK_METERS
    + STEREO_MONITOR_BLOCK_METERS
    + QU16_STEREO_FX * STEREO_FX_BLOCK_METERS;
pub const QU16_METER_RAW_BYTE_COUNT: usize = QU16_METER_VALUE_COUNT * 2;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
// A 20 ms bounded read lets the same TCP owner service UI writes at up to
// 50 Hz without a second connection or a 100 ms head-of-line stall.
const READ_TIMEOUT: Duration = Duration::from_millis(20);
const WRITE_TIMEOUT: Duration = Duration::from_millis(250);
const ACTIVE_SENSE_INTERVAL: Duration = Duration::from_millis(300);
const SYSTEM_REPLY_TIMEOUT: Duration = Duration::from_secs(5);
const END_SYNC_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_METER_TIMEOUT: Duration = Duration::from_secs(10);
const METER_STALE_TIMEOUT: Duration = Duration::from_secs(3);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_CONSECUTIVE_BAD_METER_FRAMES: usize = 3;
const CONTROL_QUEUE_CAPACITY: usize = 64;
const MAX_WRITES_PER_BATCH: usize = 64;
// One batch may contain up to 64 coalesced writes and has one `write_all`.
// Limiting a loop to one batch keeps the worst-case 250 ms write timeout below
// the 300 ms Active Sense cadence; the 20 ms loop still supports 25–30 Hz UI.
const MAX_CONTROL_BATCHES_PER_TICK: usize = 1;
const READBACK_CONFIRM_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Qu16ConnectionState {
    Stopped,
    Connecting,
    Syncing,
    Metering,
    Reconnecting,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16ChannelMeter {
    pub level_dbfs: f32,
    pub peak_dbfs: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_dbfs: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_dbfs: Option<f32>,
}

impl Qu16ChannelMeter {
    fn silent() -> Self {
        Self {
            level_dbfs: METER_SILENCE_DBFS,
            peak_dbfs: METER_SILENCE_DBFS,
            left_dbfs: None,
            right_dbfs: None,
        }
    }

    fn mono(level_dbfs: f32, peak_dbfs: f32) -> Self {
        Self {
            level_dbfs,
            peak_dbfs,
            left_dbfs: None,
            right_dbfs: None,
        }
    }

    fn stereo(left_dbfs: f32, right_dbfs: f32, peak_dbfs: f32) -> Self {
        Self {
            level_dbfs: left_dbfs.max(right_dbfs),
            peak_dbfs,
            left_dbfs: Some(left_dbfs),
            right_dbfs: Some(right_dbfs),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MasterMeter {
    pub level_dbfs: f32,
    pub peak_dbfs: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_dbfs: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_dbfs: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meter_role: Option<String>,
}

impl Qu16MasterMeter {
    fn silent() -> Self {
        Self {
            level_dbfs: METER_SILENCE_DBFS,
            peak_dbfs: METER_SILENCE_DBFS,
            left_dbfs: None,
            right_dbfs: None,
            meter_role: None,
        }
    }

    fn mono(level_dbfs: f32) -> Self {
        Self {
            level_dbfs,
            peak_dbfs: level_dbfs,
            left_dbfs: None,
            right_dbfs: None,
            meter_role: None,
        }
    }

    fn stereo(left_dbfs: f32, right_dbfs: f32) -> Self {
        let level_dbfs = left_dbfs.max(right_dbfs);
        Self {
            level_dbfs,
            peak_dbfs: level_dbfs,
            left_dbfs: Some(left_dbfs),
            right_dbfs: Some(right_dbfs),
            meter_role: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MonitorMeter {
    /// Current PAFL monitor bus. The UI should use the LR master values when
    /// no PAFL target is selected.
    pub left_dbfs: f32,
    pub right_dbfs: f32,
    pub mono_dbfs: f32,
    pub main_left_dbfs: f32,
    pub main_right_dbfs: f32,
}

impl Qu16MonitorMeter {
    fn silent() -> Self {
        Self {
            left_dbfs: METER_SILENCE_DBFS,
            right_dbfs: METER_SILENCE_DBFS,
            mono_dbfs: METER_SILENCE_DBFS,
            main_left_dbfs: METER_SILENCE_DBFS,
            main_right_dbfs: METER_SILENCE_DBFS,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MeterData {
    pub channels: BTreeMap<String, Qu16ChannelMeter>,
    pub masters: BTreeMap<String, Qu16MasterMeter>,
    pub monitor: Qu16MonitorMeter,
    pub rta_dbfs: Vec<f32>,
}

impl Qu16MeterData {
    fn silent() -> Self {
        let channels = (1..=16)
            .map(|channel| (format!("ch-{channel}"), Qu16ChannelMeter::silent()))
            .chain((1..=3).map(|channel| {
                let mut meter = Qu16ChannelMeter::silent();
                meter.left_dbfs = Some(METER_SILENCE_DBFS);
                meter.right_dbfs = Some(METER_SILENCE_DBFS);
                (format!("st-{channel}"), meter)
            }))
            .chain((1..=4).map(|fx| {
                let mut meter = Qu16ChannelMeter::silent();
                meter.left_dbfs = Some(METER_SILENCE_DBFS);
                meter.right_dbfs = Some(METER_SILENCE_DBFS);
                (format!("fx-{fx}-ret"), meter)
            }))
            .collect();
        let mono_mixes = (1..=4).map(|mix| (format!("Mix {mix}"), Qu16MasterMeter::silent()));
        let stereo_mixes = ["Mix 5-6", "Mix 7-8", "Mix 9-10", "LR"]
            .into_iter()
            .map(|mix| {
                let mut meter = Qu16MasterMeter::silent();
                meter.left_dbfs = Some(METER_SILENCE_DBFS);
                meter.right_dbfs = Some(METER_SILENCE_DBFS);
                (mix.to_string(), meter)
            });
        let fx_sends = (1..=2).map(|fx| {
            let mut meter = Qu16MasterMeter::silent();
            meter.left_dbfs = Some(METER_SILENCE_DBFS);
            meter.right_dbfs = Some(METER_SILENCE_DBFS);
            (format!("FX {fx}"), meter)
        });
        Self {
            channels,
            masters: mono_mixes.chain(stereo_mixes).chain(fx_sends).collect(),
            monitor: Qu16MonitorMeter::silent(),
            rta_dbfs: vec![METER_SILENCE_DBFS; 31],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MeterSnapshot {
    pub source: String,
    pub session_id: u64,
    pub connected: bool,
    pub state: Qu16ConnectionState,
    pub updated_at_ms: u64,
    pub frame_sequence: u64,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub midi_channel: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    pub channels: BTreeMap<String, Qu16ChannelMeter>,
    pub masters: BTreeMap<String, Qu16MasterMeter>,
    pub monitor: Qu16MonitorMeter,
    pub rta_dbfs: Vec<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Qu16MeterSnapshot {
    fn cleared(
        host: impl Into<String>,
        state: Qu16ConnectionState,
        error: Option<String>,
        session_id: u64,
    ) -> Self {
        let data = Qu16MeterData::silent();
        Self {
            source: QU16_METER_SOURCE.to_string(),
            session_id,
            connected: false,
            state,
            updated_at_ms: unix_time_ms(),
            frame_sequence: 0,
            host: host.into(),
            midi_channel: None,
            firmware: None,
            channels: data.channels,
            masters: data.masters,
            monitor: data.monitor,
            rta_dbfs: data.rta_dbfs,
            error,
        }
    }

    fn live(
        host: String,
        midi_channel: u8,
        firmware: String,
        frame_sequence: u64,
        data: Qu16MeterData,
        session_id: u64,
    ) -> Self {
        Self {
            source: QU16_METER_SOURCE.to_string(),
            session_id,
            connected: true,
            state: Qu16ConnectionState::Metering,
            updated_at_ms: unix_time_ms(),
            frame_sequence,
            host,
            midi_channel: Some(midi_channel),
            firmware: Some(firmware),
            channels: data.channels,
            masters: data.masters,
            monitor: data.monitor,
            rta_dbfs: data.rta_dbfs,
            error: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Qu16PendingStage {
    Queued,
    AwaitingReadback,
    SentUnconfirmed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16PendingParameter {
    pub state: Qu16PendingStage,
    pub expected_value: u8,
}

/// Authoritative control-plane state for one runtime session. `parameters` is
/// intentionally a plain string-to-u8 map because the frontend decoder owns
/// all UI/dB conversion. `pending` remains a numeric count for the current UI;
/// detailed lifecycle is separately observable in `pendingDetails`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16ParameterSnapshot {
    pub host: String,
    pub session_id: u64,
    pub connected: bool,
    pub synced: bool,
    pub revision: u64,
    pub updated_at_ms: u64,
    pub parameters: BTreeMap<String, u8>,
    pub pending: usize,
    pub pending_details: BTreeMap<String, Qu16PendingParameter>,
    pub connection_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub midi_channel: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Qu16ParameterSnapshot {
    fn cleared(
        host: impl Into<String>,
        session_id: u64,
        revision: u64,
        connection_epoch: u64,
        error: Option<String>,
    ) -> Self {
        Self {
            host: host.into(),
            session_id,
            connected: false,
            synced: false,
            revision,
            updated_at_ms: unix_time_ms(),
            parameters: BTreeMap::new(),
            pending: 0,
            pending_details: BTreeMap::new(),
            connection_epoch,
            midi_channel: None,
            firmware: None,
            error,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Qu16SystemState {
    /// Raw zero-based MIDI channel nibble returned in the SysEx header.
    pub midi_channel: u8,
    pub box_id: u8,
    pub firmware_major: u8,
    pub firmware_minor: u8,
}

impl Qu16SystemState {
    pub fn firmware(self) -> String {
        format!("{}.{}", self.firmware_major, self.firmware_minor)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Qu16ProtocolError {
    EmptyPackedData,
    NonSevenBitData { index: usize, value: u8 },
    TruncatedPackedGroup,
    InvalidSysex(&'static str),
    UnexpectedCommand { expected: u8, actual: u8 },
    UnsupportedMixer { box_id: u8 },
    MeterPayloadSize { expected: usize, actual: usize },
}

impl fmt::Display for Qu16ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPackedData => write!(formatter, "meter packet contains no packed data"),
            Self::NonSevenBitData { index, value } => write!(
                formatter,
                "packed SysEx byte {index} is not 7-bit data: 0x{value:02X}"
            ),
            Self::TruncatedPackedGroup => {
                write!(formatter, "packed meter data ends after an MSB group byte")
            }
            Self::InvalidSysex(reason) => write!(formatter, "invalid Qu SysEx: {reason}"),
            Self::UnexpectedCommand { expected, actual } => write!(
                formatter,
                "unexpected Qu SysEx command 0x{actual:02X}; expected 0x{expected:02X}"
            ),
            Self::UnsupportedMixer { box_id } => {
                write!(
                    formatter,
                    "connected Qu mixer BoxID {box_id} is not a Qu-16"
                )
            }
            Self::MeterPayloadSize { expected, actual } => write!(
                formatter,
                "Qu-16 meter payload has {actual} decoded bytes; expected {expected}"
            ),
        }
    }
}

impl std::error::Error for Qu16ProtocolError {}

#[derive(Debug)]
pub enum Qu16RuntimeError {
    EmptyHost,
    WorkerStart(io::Error),
    EmptyWriteBatch,
    WriteBatchTooLarge { maximum: usize, actual: usize },
    DuplicateParameterKey(String),
    InvalidControl(String),
    StaleSession { expected: u64, actual: u64 },
    NotConnected,
    NotSynced,
    ControlQueueFull,
    ControlQueueClosed,
}

impl fmt::Display for Qu16RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyHost => write!(formatter, "Qu-16 host must not be empty"),
            Self::WorkerStart(error) => write!(formatter, "failed to start Qu-16 worker: {error}"),
            Self::EmptyWriteBatch => write!(formatter, "Qu-16 write batch must not be empty"),
            Self::WriteBatchTooLarge { maximum, actual } => write!(
                formatter,
                "Qu-16 write batch has {actual} items; maximum is {maximum}"
            ),
            Self::DuplicateParameterKey(key) => {
                write!(formatter, "Qu-16 write batch repeats canonical key {key}")
            }
            Self::InvalidControl(error) => {
                write!(formatter, "invalid Qu-16 control write: {error}")
            }
            Self::StaleSession { expected, actual } => write!(
                formatter,
                "stale Qu-16 session {actual}; active session is {expected}"
            ),
            Self::NotConnected => write!(formatter, "Qu-16 control connection is not live"),
            Self::NotSynced => write!(formatter, "Qu-16 control state has not reached End Sync"),
            Self::ControlQueueFull => write!(formatter, "Qu-16 control write queue is full"),
            Self::ControlQueueClosed => write!(formatter, "Qu-16 control worker is not running"),
        }
    }
}

impl std::error::Error for Qu16RuntimeError {}

/// Build the required All Call Get System State request. The Qu-Pad flag is
/// enabled, therefore the runtime starts Active Sense immediately and keeps it
/// at the protocol's approximately 300 ms cadence.
pub fn build_get_system_state_request() -> Vec<u8> {
    let mut message = Vec::with_capacity(12);
    message.extend_from_slice(&QU_SYSEX_PREFIX);
    message.extend_from_slice(&[ALL_CALL, COMMAND_GET_SYSTEM_STATE, 0x01, SYSEX_END]);
    message
}

/// Build MeterOn=1 or MeterOn=0 using the MIDI channel learned from the system
/// state reply. A caller must never guess this channel before the All Call.
pub fn build_meter_request(midi_channel: u8, enabled: bool) -> Result<Vec<u8>, Qu16ProtocolError> {
    if midi_channel > 0x0F {
        return Err(Qu16ProtocolError::InvalidSysex(
            "MIDI channel must be in the range 0..15",
        ));
    }
    let mut message = Vec::with_capacity(12);
    message.extend_from_slice(&QU_SYSEX_PREFIX);
    message.extend_from_slice(&[
        midi_channel,
        COMMAND_METER_REQUEST,
        u8::from(enabled),
        SYSEX_END,
    ]);
    Ok(message)
}

pub fn parse_system_state_reply(message: &[u8]) -> Result<Qu16SystemState, Qu16ProtocolError> {
    let (midi_channel, command, payload) = parse_qu_sysex(message)?;
    if command != COMMAND_SYSTEM_STATE {
        return Err(Qu16ProtocolError::UnexpectedCommand {
            expected: COMMAND_SYSTEM_STATE,
            actual: command,
        });
    }
    if payload.len() != 3 {
        return Err(Qu16ProtocolError::InvalidSysex(
            "system state reply must contain BoxID, major and minor version",
        ));
    }
    if payload[0] != QU16_BOX_ID {
        return Err(Qu16ProtocolError::UnsupportedMixer { box_id: payload[0] });
    }
    Ok(Qu16SystemState {
        midi_channel,
        box_id: payload[0],
        firmware_major: payload[1],
        firmware_minor: payload[2],
    })
}

fn is_matching_end_sync(
    midi_channel: u8,
    command: u8,
    payload: &[u8],
    system_state: Qu16SystemState,
) -> bool {
    command == COMMAND_END_SYNC && midi_channel == system_state.midi_channel && payload.is_empty()
}

/// Reverse the MIDI SysEx 7-bitization described on protocol page 11.
/// The MSB byte precedes up to seven low-seven-bit bytes; its bits 6..0 belong
/// to output bytes A..G respectively.
pub fn decode_7bitized(packed: &[u8]) -> Result<Vec<u8>, Qu16ProtocolError> {
    if packed.is_empty() {
        return Err(Qu16ProtocolError::EmptyPackedData);
    }
    for (index, value) in packed.iter().copied().enumerate() {
        if value > 0x7F {
            return Err(Qu16ProtocolError::NonSevenBitData { index, value });
        }
    }

    let mut decoded = Vec::with_capacity(packed.len() * 7 / 8 + 7);
    let mut offset = 0;
    while offset < packed.len() {
        let high_bits = packed[offset];
        offset += 1;
        if offset == packed.len() {
            return Err(Qu16ProtocolError::TruncatedPackedGroup);
        }
        let bytes_in_group = (packed.len() - offset).min(7);
        for index in 0..bytes_in_group {
            let high_bit = (high_bits >> (6 - index)) & 0x01;
            decoded.push(packed[offset + index] | (high_bit << 7));
        }
        offset += bytes_in_group;
    }
    Ok(decoded)
}

pub fn decode_7q8_dbfs(bytes: [u8; 2]) -> f32 {
    let offset_value = u16::from_be_bytes(bytes) as i32;
    (offset_value - 0x8000) as f32 / 256.0
}

pub fn parse_qu16_meter_reply(message: &[u8]) -> Result<Qu16MeterData, Qu16ProtocolError> {
    let (_, command, payload) = parse_qu_sysex(message)?;
    if command != COMMAND_METER_DATA {
        return Err(Qu16ProtocolError::UnexpectedCommand {
            expected: COMMAND_METER_DATA,
            actual: command,
        });
    }
    let raw = decode_7bitized(payload)?;
    if raw.len() != QU16_METER_RAW_BYTE_COUNT {
        return Err(Qu16ProtocolError::MeterPayloadSize {
            expected: QU16_METER_RAW_BYTE_COUNT,
            actual: raw.len(),
        });
    }
    let values: Vec<f32> = raw
        .chunks_exact(2)
        .map(|chunk| decode_7q8_dbfs([chunk[0], chunk[1]]))
        .collect();
    parse_qu16_meter_values(&values)
}

fn parse_qu_sysex(message: &[u8]) -> Result<(u8, u8, &[u8]), Qu16ProtocolError> {
    if message.len() < QU_SYSEX_PREFIX.len() + 3 {
        return Err(Qu16ProtocolError::InvalidSysex("message is too short"));
    }
    if !message.starts_with(&QU_SYSEX_PREFIX) {
        return Err(Qu16ProtocolError::InvalidSysex(
            "manufacturer/product header does not match Qu",
        ));
    }
    if message.last().copied() != Some(SYSEX_END) {
        return Err(Qu16ProtocolError::InvalidSysex(
            "message has no F7 terminator",
        ));
    }
    let midi_channel = message[8];
    if midi_channel > 0x0F {
        return Err(Qu16ProtocolError::InvalidSysex(
            "reply MIDI channel is outside 0..15",
        ));
    }
    Ok((midi_channel, message[9], &message[10..message.len() - 1]))
}

fn parse_qu16_meter_values(values: &[f32]) -> Result<Qu16MeterData, Qu16ProtocolError> {
    if values.len() != QU16_METER_VALUE_COUNT {
        return Err(Qu16ProtocolError::MeterPayloadSize {
            expected: QU16_METER_RAW_BYTE_COUNT,
            actual: values.len() * 2,
        });
    }
    let mut cursor = MeterCursor::new(values);
    let mut channels = BTreeMap::new();
    let mut masters = BTreeMap::new();

    for channel in 1..=QU16_MONO_INPUTS {
        let block = cursor.take(MONO_INPUT_BLOCK_METERS);
        // Post Delay is the strip's primary reading. The processing-path peak
        // uses Post Preamp, Post PEQ, Post Compressor and Post Delay.
        channels.insert(
            format!("ch-{channel}"),
            Qu16ChannelMeter::mono(block[3], max_dbfs(&block[0..4])),
        );
    }

    cursor.skip(QU16_UNUSED_AFTER_MONO_INPUTS);

    for channel in 1..=QU16_STEREO_INPUTS {
        let block = cursor.take(STEREO_INPUT_BLOCK_METERS);
        let left = block[3];
        let right = block[13];
        let peak = max_dbfs(&block[0..4]).max(max_dbfs(&block[10..14]));
        channels.insert(
            format!("st-{channel}"),
            Qu16ChannelMeter::stereo(left, right, peak),
        );
    }

    cursor.skip(QU16_UNUSED_AFTER_STEREO_INPUTS);

    for mix in 1..=QU16_MONO_MIXES {
        let block = cursor.take(MONO_MIX_BLOCK_METERS);
        masters.insert(format!("Mix {mix}"), Qu16MasterMeter::mono(block[5]));
    }

    for mix in ["Mix 5-6", "Mix 7-8", "Mix 9-10", "LR"] {
        let block = cursor.take(STEREO_MIX_BLOCK_METERS);
        masters.insert(
            mix.to_string(),
            Qu16MasterMeter::stereo(block[5], block[15]),
        );
    }

    let monitor_block = cursor.take(STEREO_MONITOR_BLOCK_METERS);
    let monitor = Qu16MonitorMeter {
        left_dbfs: monitor_block[0],
        right_dbfs: monitor_block[1],
        mono_dbfs: monitor_block[2],
        main_left_dbfs: monitor_block[7],
        main_right_dbfs: monitor_block[8],
    };
    let rta_left = &monitor_block[16..47];
    let rta_right = &monitor_block[47..78];
    let rta_dbfs = rta_left
        .iter()
        .zip(rta_right)
        .map(|(left, right)| left.max(*right))
        .collect();

    // Four 18-value RackFX blocks complete the Qu-16 V1.9 payload. Post-PEQ
    // L/R (7/8) are the four FX Return channel meters. Send L/R/mono (0/1/2)
    // describe the live RackFX input; for the factory Mix>Return patch this is
    // also the observable FX1/FX2 Send master meter. If a slot is repatched to
    // Channel/Insert/another Mix, the value remains truthfully the RackFX input
    // rather than a fabricated dedicated FX bus meter.
    for fx in 1..=QU16_STEREO_FX {
        let block = cursor.take(STEREO_FX_BLOCK_METERS);
        let return_left = block[7];
        let return_right = block[8];
        let return_peak = block[3].max(block[4]).max(return_left).max(return_right);
        channels.insert(
            format!("fx-{fx}-ret"),
            Qu16ChannelMeter::stereo(return_left, return_right, return_peak),
        );
        if fx <= 2 {
            let send_peak = block[0].max(block[1]).max(block[2]);
            masters.insert(
                format!("FX {fx}"),
                Qu16MasterMeter {
                    level_dbfs: block[2],
                    peak_dbfs: send_peak,
                    left_dbfs: Some(block[0]),
                    right_dbfs: Some(block[1]),
                    meter_role: Some("rack-fx-input".into()),
                },
            );
        }
    }
    debug_assert_eq!(cursor.position, values.len());

    Ok(Qu16MeterData {
        channels,
        masters,
        monitor,
        rta_dbfs,
    })
}

struct MeterCursor<'a> {
    values: &'a [f32],
    position: usize,
}

impl<'a> MeterCursor<'a> {
    fn new(values: &'a [f32]) -> Self {
        Self {
            values,
            position: 0,
        }
    }

    fn take(&mut self, count: usize) -> &'a [f32] {
        let start = self.position;
        self.position += count;
        &self.values[start..self.position]
    }

    fn skip(&mut self, count: usize) {
        self.position += count;
    }
}

fn max_dbfs(values: &[f32]) -> f32 {
    values.iter().copied().fold(METER_SILENCE_DBFS, f32::max)
}

type SnapshotCallback = Arc<dyn Fn(Qu16MeterSnapshot) + Send + Sync + 'static>;
type ParameterCallback = Arc<dyn Fn(Qu16ParameterSnapshot) + Send + Sync + 'static>;

#[derive(Clone, Debug)]
struct PreparedControlWrite {
    command: Qu16ControlCommand,
    key: String,
    expected_value: u8,
}

#[derive(Clone, Debug)]
struct ControlWriteBatch {
    session_id: u64,
    connection_epoch: u64,
    writes: Vec<PreparedControlWrite>,
}

#[derive(Clone, Debug)]
struct PendingWrite {
    expected_value: u8,
    sent_at: Instant,
    stage: Qu16PendingStage,
}

struct WorkerControl {
    stop: mpsc::Sender<()>,
    writes: SyncSender<ControlWriteBatch>,
    join: JoinHandle<()>,
}

struct RuntimeInner {
    /// Serializes stop/join/start so the Qu-16 never sees two generic TCP MIDI
    /// clients from this process at the same time.
    lifecycle: Mutex<()>,
    generation: AtomicU64,
    worker: Mutex<Option<WorkerControl>>,
    snapshot: Mutex<Qu16MeterSnapshot>,
    parameter_snapshot: Mutex<Qu16ParameterSnapshot>,
}

#[derive(Clone)]
pub struct Qu16Runtime {
    inner: Arc<RuntimeInner>,
}

impl Default for Qu16Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Qu16Runtime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                lifecycle: Mutex::new(()),
                generation: AtomicU64::new(0),
                worker: Mutex::new(None),
                snapshot: Mutex::new(Qu16MeterSnapshot::cleared(
                    "",
                    Qu16ConnectionState::Stopped,
                    None,
                    0,
                )),
                parameter_snapshot: Mutex::new(Qu16ParameterSnapshot::cleared("", 0, 0, 0, None)),
            }),
        }
    }

    /// Start one TCP meter worker. Starting again first stops and joins the
    /// previous worker, preserving the Qu rule that only one TCP MIDI client
    /// may be connected at a time.
    pub fn start_metering<F>(
        &self,
        host: impl Into<String>,
        on_frame: F,
    ) -> Result<u64, Qu16RuntimeError>
    where
        F: Fn(Qu16MeterSnapshot) + Send + Sync + 'static,
    {
        self.start_metering_with_callbacks(host, on_frame, |_| {})
    }

    /// Starts the one shared TCP worker and exposes independent meter and
    /// parameter callbacks. Parameter events are never routed through the
    /// meter-frame throttle in the application shell.
    pub fn start_metering_with_callbacks<F, P>(
        &self,
        host: impl Into<String>,
        on_meter_frame: F,
        on_parameter_frame: P,
    ) -> Result<u64, Qu16RuntimeError>
    where
        F: Fn(Qu16MeterSnapshot) + Send + Sync + 'static,
        P: Fn(Qu16ParameterSnapshot) + Send + Sync + 'static,
    {
        let host = host.into().trim().to_string();
        if host.is_empty() {
            return Err(Qu16RuntimeError::EmptyHost);
        }
        let _lifecycle = lock_unpoisoned(&self.inner.lifecycle);
        let session_id = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.stop_worker_locked();

        let callback: SnapshotCallback = Arc::new(on_meter_frame);
        let parameter_callback: ParameterCallback = Arc::new(on_parameter_frame);
        publish_snapshot(
            &self.inner,
            &callback,
            session_id,
            Qu16MeterSnapshot::cleared(
                host.clone(),
                Qu16ConnectionState::Connecting,
                None,
                session_id,
            ),
        );
        publish_parameter_replacement(
            &self.inner,
            &parameter_callback,
            session_id,
            host.clone(),
            0,
            None,
        );

        let (stop, stop_receiver) = mpsc::channel();
        let (writes, write_receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);
        let worker_inner = Arc::clone(&self.inner);
        let worker_callback = Arc::clone(&callback);
        let worker_parameter_callback = Arc::clone(&parameter_callback);
        let worker_host = host.clone();
        // Hold the lifecycle slot across spawn + install so a concurrent stop
        // cannot miss the newly-created thread in that small interval.
        let mut worker_slot = lock_unpoisoned(&self.inner.worker);
        let join = match thread::Builder::new()
            .name("qu16-meter-runtime".to_string())
            .spawn(move || {
                meter_worker(
                    worker_host,
                    worker_inner,
                    worker_callback,
                    worker_parameter_callback,
                    stop_receiver,
                    write_receiver,
                    session_id,
                )
            }) {
            Ok(join) => join,
            Err(error) => {
                drop(worker_slot);
                publish_snapshot(
                    &self.inner,
                    &callback,
                    session_id,
                    Qu16MeterSnapshot::cleared(
                        host.clone(),
                        Qu16ConnectionState::Error,
                        Some(format!("worker start failed: {error}")),
                        session_id,
                    ),
                );
                publish_parameter_replacement(
                    &self.inner,
                    &parameter_callback,
                    session_id,
                    host,
                    0,
                    Some(format!("worker start failed: {error}")),
                );
                return Err(Qu16RuntimeError::WorkerStart(error));
            }
        };
        *worker_slot = Some(WorkerControl { stop, writes, join });
        Ok(session_id)
    }

    /// Convenience adapter for callers that prefer a receiver. The bounded
    /// queue keeps a slow UI from applying back-pressure to the TCP reader;
    /// intermediate frames may be dropped, but the latest shared status is
    /// always retained by `meter_status`.
    #[allow(dead_code)]
    pub fn start_metering_channel(
        &self,
        host: impl Into<String>,
        capacity: usize,
    ) -> Result<Receiver<Qu16MeterSnapshot>, Qu16RuntimeError> {
        let (sender, receiver) = mpsc::sync_channel(capacity.max(1));
        let _session_id = self.start_metering(host, move |snapshot| {
            send_latest(&sender, snapshot);
        })?;
        Ok(receiver)
    }

    pub fn stop_metering(&self) -> Qu16MeterSnapshot {
        let _lifecycle = lock_unpoisoned(&self.inner.lifecycle);
        self.stop_metering_locked(None)
    }

    /// Stop only the session owned by the caller. A stale React cleanup must
    /// never tear down a newer host/session that has already replaced it.
    pub fn stop_metering_if(&self, session_id: u64) -> Qu16MeterSnapshot {
        let _lifecycle = lock_unpoisoned(&self.inner.lifecycle);
        self.stop_metering_locked(Some(session_id))
    }

    fn stop_metering_locked(&self, expected_session_id: Option<u64>) -> Qu16MeterSnapshot {
        let current_session_id = self.inner.generation.load(Ordering::Acquire);
        if expected_session_id.is_some_and(|expected| expected != current_session_id) {
            return self.meter_status();
        }
        let session_id = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let current = self.meter_status();
        self.stop_worker_locked();
        let snapshot = Qu16MeterSnapshot::cleared(
            current.host.clone(),
            Qu16ConnectionState::Stopped,
            None,
            session_id,
        );
        *lock_unpoisoned(&self.inner.snapshot) = snapshot.clone();
        let next_revision = lock_unpoisoned(&self.inner.parameter_snapshot)
            .revision
            .saturating_add(1);
        *lock_unpoisoned(&self.inner.parameter_snapshot) =
            Qu16ParameterSnapshot::cleared(current.host, session_id, next_revision, 0, None);
        snapshot
    }

    fn stop_worker_locked(&self) {
        let worker = lock_unpoisoned(&self.inner.worker).take();
        if let Some(worker) = worker {
            let _ = worker.stop.send(());
            // A callback may request its own shutdown. Joining the current
            // thread would deadlock; dropping that handle safely detaches it,
            // and the stop message is observed immediately after the callback.
            if worker.join.thread().id() != thread::current().id() {
                let _ = worker.join.join();
            }
        }
    }

    pub fn meter_status(&self) -> Qu16MeterSnapshot {
        lock_unpoisoned(&self.inner.snapshot).clone()
    }

    pub fn parameter_status(&self) -> Qu16ParameterSnapshot {
        lock_unpoisoned(&self.inner.parameter_snapshot).clone()
    }

    /// Atomically validates a semantic batch, rejects duplicate canonical
    /// keys, records `queued`, then attempts one bounded enqueue. Nothing from
    /// an invalid batch is observable by the worker.
    pub fn write_parameters(
        &self,
        session_id: u64,
        writes: Vec<Qu16ParameterWrite>,
    ) -> Result<Qu16ParameterSnapshot, Qu16RuntimeError> {
        let _lifecycle = lock_unpoisoned(&self.inner.lifecycle);
        if writes.is_empty() {
            return Err(Qu16RuntimeError::EmptyWriteBatch);
        }
        if writes.len() > MAX_WRITES_PER_BATCH {
            return Err(Qu16RuntimeError::WriteBatchTooLarge {
                maximum: MAX_WRITES_PER_BATCH,
                actual: writes.len(),
            });
        }

        let mut prepared = Vec::with_capacity(writes.len());
        let mut keys = std::collections::BTreeSet::new();
        for write in &writes {
            let command = command_from_parameter_write(write)
                .map_err(|error| Qu16RuntimeError::InvalidControl(error.to_string()))?;
            let expected = command
                .expected_parameter()
                .map_err(|error| Qu16RuntimeError::InvalidControl(error.to_string()))?;
            if !keys.insert(expected.key.clone()) {
                return Err(Qu16RuntimeError::DuplicateParameterKey(expected.key));
            }
            prepared.push(PreparedControlWrite {
                command,
                key: expected.key,
                expected_value: expected.value,
            });
        }

        let active_session = self.inner.generation.load(Ordering::Acquire);
        if session_id != active_session {
            return Err(Qu16RuntimeError::StaleSession {
                expected: active_session,
                actual: session_id,
            });
        }

        // Keep the snapshot lock through bounded enqueue and queued-state
        // insertion. A fast worker can receive immediately, but its transition
        // to awaiting-readback must wait until queued is visible.
        let mut snapshot = lock_unpoisoned(&self.inner.parameter_snapshot);
        if !snapshot.connected {
            return Err(Qu16RuntimeError::NotConnected);
        }
        if !snapshot.synced {
            return Err(Qu16RuntimeError::NotSynced);
        }
        let connection_epoch = snapshot.connection_epoch;
        let batch = ControlWriteBatch {
            session_id,
            connection_epoch,
            writes: prepared.clone(),
        };

        let send_result = {
            let worker = lock_unpoisoned(&self.inner.worker);
            let Some(worker) = worker.as_ref() else {
                return Err(Qu16RuntimeError::ControlQueueClosed);
            };
            worker.writes.try_send(batch)
        };
        match send_result {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return Err(Qu16RuntimeError::ControlQueueFull),
            Err(TrySendError::Disconnected(_)) => return Err(Qu16RuntimeError::ControlQueueClosed),
        }

        for write in prepared {
            snapshot.pending_details.insert(
                write.key,
                Qu16PendingParameter {
                    state: Qu16PendingStage::Queued,
                    expected_value: write.expected_value,
                },
            );
        }
        snapshot.pending = snapshot.pending_details.len();
        snapshot.revision = snapshot.revision.saturating_add(1);
        snapshot.updated_at_ms = unix_time_ms();
        debug_assert_eq!(snapshot.connection_epoch, connection_epoch);
        Ok(snapshot.clone())
    }
}

#[allow(dead_code)]
fn send_latest(sender: &SyncSender<Qu16MeterSnapshot>, snapshot: Qu16MeterSnapshot) {
    let _ = sender.try_send(snapshot);
}

enum ConnectionOutcome {
    Stopped,
    Retry(String),
    Fatal(String),
}

fn meter_worker(
    host: String,
    inner: Arc<RuntimeInner>,
    callback: SnapshotCallback,
    parameter_callback: ParameterCallback,
    stop: Receiver<()>,
    writes: Receiver<ControlWriteBatch>,
    session_id: u64,
) {
    let mut frame_sequence = 0_u64;
    let mut connection_epoch = 0_u64;
    loop {
        if stop_requested(&stop) {
            publish_snapshot(
                &inner,
                &callback,
                session_id,
                Qu16MeterSnapshot::cleared(
                    host.clone(),
                    Qu16ConnectionState::Stopped,
                    None,
                    session_id,
                ),
            );
            publish_parameter_replacement(
                &inner,
                &parameter_callback,
                session_id,
                host.clone(),
                connection_epoch,
                None,
            );
            return;
        }
        connection_epoch = connection_epoch.saturating_add(1);
        publish_snapshot(
            &inner,
            &callback,
            session_id,
            Qu16MeterSnapshot::cleared(
                host.clone(),
                Qu16ConnectionState::Connecting,
                None,
                session_id,
            ),
        );
        publish_parameter_replacement(
            &inner,
            &parameter_callback,
            session_id,
            host.clone(),
            connection_epoch,
            None,
        );

        match run_connection(
            &host,
            &inner,
            &callback,
            &parameter_callback,
            &stop,
            &writes,
            &mut frame_sequence,
            session_id,
            connection_epoch,
        ) {
            ConnectionOutcome::Stopped => {
                publish_snapshot(
                    &inner,
                    &callback,
                    session_id,
                    Qu16MeterSnapshot::cleared(
                        host.clone(),
                        Qu16ConnectionState::Stopped,
                        None,
                        session_id,
                    ),
                );
                publish_parameter_replacement(
                    &inner,
                    &parameter_callback,
                    session_id,
                    host.clone(),
                    connection_epoch,
                    None,
                );
                return;
            }
            ConnectionOutcome::Fatal(error) => {
                publish_snapshot(
                    &inner,
                    &callback,
                    session_id,
                    Qu16MeterSnapshot::cleared(
                        host.clone(),
                        Qu16ConnectionState::Error,
                        Some(error.clone()),
                        session_id,
                    ),
                );
                drain_write_queue(&writes);
                publish_parameter_replacement(
                    &inner,
                    &parameter_callback,
                    session_id,
                    host.clone(),
                    connection_epoch,
                    Some(error),
                );
                return;
            }
            ConnectionOutcome::Retry(error) => {
                publish_snapshot(
                    &inner,
                    &callback,
                    session_id,
                    Qu16MeterSnapshot::cleared(
                        host.clone(),
                        Qu16ConnectionState::Reconnecting,
                        Some(error.clone()),
                        session_id,
                    ),
                );
                // Old-connection commands are never replayed. The epoch is
                // also checked inside run_connection to close the enqueue vs.
                // disconnect race before this drain.
                drain_write_queue(&writes);
                publish_parameter_replacement(
                    &inner,
                    &parameter_callback,
                    session_id,
                    host.clone(),
                    connection_epoch,
                    Some(error),
                );
                match stop.recv_timeout(RECONNECT_DELAY) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        publish_snapshot(
                            &inner,
                            &callback,
                            session_id,
                            Qu16MeterSnapshot::cleared(
                                host.clone(),
                                Qu16ConnectionState::Stopped,
                                None,
                                session_id,
                            ),
                        );
                        publish_parameter_replacement(
                            &inner,
                            &parameter_callback,
                            session_id,
                            host.clone(),
                            connection_epoch,
                            None,
                        );
                        return;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        }
    }
}

fn run_connection(
    host: &str,
    inner: &Arc<RuntimeInner>,
    callback: &SnapshotCallback,
    parameter_callback: &ParameterCallback,
    stop: &Receiver<()>,
    writes: &Receiver<ControlWriteBatch>,
    frame_sequence: &mut u64,
    session_id: u64,
    connection_epoch: u64,
) -> ConnectionOutcome {
    let mut stream = match connect(host) {
        Ok(stream) => stream,
        Err(error) => return ConnectionOutcome::Retry(error),
    };
    publish_snapshot(
        inner,
        callback,
        session_id,
        Qu16MeterSnapshot::cleared(host, Qu16ConnectionState::Syncing, None, session_id),
    );
    update_parameter_snapshot(
        inner,
        parameter_callback,
        session_id,
        connection_epoch,
        |snapshot| {
            snapshot.connected = true;
            snapshot.error = None;
            true
        },
    );

    if let Err(error) = stream.write_all(&build_get_system_state_request()) {
        return ConnectionOutcome::Retry(format!("Get System State write failed: {error}"));
    }
    if let Err(error) = stream.write_all(&[ACTIVE_SENSE]) {
        return ConnectionOutcome::Retry(format!("initial Active Sense write failed: {error}"));
    }

    let started = Instant::now();
    let mut last_active_sense = Instant::now();
    let mut meter_enabled_at = None;
    let mut last_meter_at = None;
    let mut system_state: Option<Qu16SystemState> = None;
    let mut control_observer: Option<Qu16ControlObserver> = None;
    let mut synced = false;
    let mut pending_writes: BTreeMap<String, PendingWrite> = BTreeMap::new();
    let mut invalid_meter_frames = 0;
    let mut decoder = MidiStreamDecoder::default();
    let mut buffer = [0_u8; 4_096];

    loop {
        if stop_requested(stop) {
            if let Some(state) = system_state {
                if let Ok(off) = build_meter_request(state.midi_channel, false) {
                    let _ = stream.write_all(&off);
                }
            }
            return ConnectionOutcome::Stopped;
        }

        // Heartbeat always wins scheduling priority over operator writes.
        if last_active_sense.elapsed() >= ACTIVE_SENSE_INTERVAL {
            if let Err(error) = stream.write_all(&[ACTIVE_SENSE]) {
                return ConnectionOutcome::Retry(format!("Active Sense write failed: {error}"));
            }
            last_active_sense = Instant::now();
        }

        if let Err(error) = service_control_batches(
            &mut stream,
            writes,
            inner,
            parameter_callback,
            session_id,
            connection_epoch,
            system_state,
            synced,
            &mut pending_writes,
        ) {
            return ConnectionOutcome::Retry(error);
        }

        let timed_out: Vec<String> = pending_writes
            .iter_mut()
            .filter_map(|(key, pending)| {
                if pending.stage == Qu16PendingStage::AwaitingReadback
                    && pending.sent_at.elapsed() >= READBACK_CONFIRM_TIMEOUT
                {
                    pending.stage = Qu16PendingStage::SentUnconfirmed;
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect();
        if !timed_out.is_empty() {
            update_parameter_snapshot(
                inner,
                parameter_callback,
                session_id,
                connection_epoch,
                |snapshot| {
                    set_pending_stage(snapshot, &timed_out, Qu16PendingStage::SentUnconfirmed);
                    true
                },
            );
        }

        match stream.read(&mut buffer) {
            Ok(0) => return ConnectionOutcome::Retry("Qu-16 closed the TCP connection".into()),
            Ok(count) => {
                let mut observations = Vec::new();
                for decoded in decoder.push(&buffer[..count]) {
                    let message = match decoded {
                        Ok(message) => message,
                        Err(error) if !synced => {
                            // End Sync is our completeness boundary. Any
                            // framing loss before it would make the initial
                            // parameter map unknowably partial, so reconnect
                            // instead of advertising synced state.
                            return ConnectionOutcome::Retry(format!(
                                "MIDI decode failed during Qu-16 sync: {error}"
                            ));
                        }
                        // After a complete sync, one malformed MIDI item is
                        // recoverable and valid items from the same TCP read
                        // remain usable.
                        Err(_) => {
                            // A framing error can interrupt an NRPN selector
                            // sequence. Drop assembler partials so later Data
                            // Entry bytes cannot be joined to stale selectors.
                            reset_control_observer(&mut control_observer);
                            continue;
                        }
                    };
                    match &message {
                        MidiMessage::SysEx(sysex) => {
                            let Ok((midi_channel, command, payload)) = parse_qu_sysex(sysex) else {
                                continue;
                            };
                            match command {
                                COMMAND_SYSTEM_STATE if system_state.is_none() => {
                                    let state = match parse_system_state_reply(sysex) {
                                        Ok(state) => state,
                                        Err(Qu16ProtocolError::UnsupportedMixer { box_id }) => {
                                            return ConnectionOutcome::Fatal(format!(
                                                "Qu BoxID {box_id} is not the configured Qu-16"
                                            ));
                                        }
                                        Err(error) => {
                                            return ConnectionOutcome::Retry(format!(
                                                "invalid Get System State reply: {error}"
                                            ));
                                        }
                                    };
                                    let observer =
                                        match Qu16ControlObserver::new(state.midi_channel) {
                                            Ok(observer) => observer,
                                            Err(error) => {
                                                return ConnectionOutcome::Fatal(error.to_string())
                                            }
                                        };
                                    control_observer = Some(observer);
                                    system_state = Some(state);
                                    update_parameter_snapshot(
                                        inner,
                                        parameter_callback,
                                        session_id,
                                        connection_epoch,
                                        |snapshot| {
                                            snapshot.connected = true;
                                            snapshot.synced = false;
                                            snapshot.midi_channel = Some(state.midi_channel);
                                            snapshot.firmware = Some(state.firmware());
                                            snapshot.error = None;
                                            true
                                        },
                                    );
                                }
                                COMMAND_END_SYNC => {
                                    let Some(state) = system_state else {
                                        continue;
                                    };
                                    if !is_matching_end_sync(midi_channel, command, payload, state)
                                    {
                                        continue;
                                    }
                                    if !synced {
                                        // Channel messages earlier in this
                                        // same TCP read have already been
                                        // decoded but were not yet committed.
                                        // End Sync and that prefix of the
                                        // parameter map must become visible in
                                        // one revision, never as a transient
                                        // synced=true/incomplete frame.
                                        let synchronized_observations =
                                            std::mem::take(&mut observations);
                                        reconcile_pending_observations(
                                            &mut pending_writes,
                                            &synchronized_observations,
                                        );
                                        update_parameter_snapshot(
                                            inner,
                                            parameter_callback,
                                            session_id,
                                            connection_epoch,
                                            |snapshot| {
                                                complete_parameter_sync(
                                                    snapshot,
                                                    &synchronized_observations,
                                                );
                                                true
                                            },
                                        );
                                        synced = true;
                                        let meter_on =
                                            match build_meter_request(state.midi_channel, true) {
                                                Ok(message) => message,
                                                Err(error) => {
                                                    return ConnectionOutcome::Fatal(
                                                        error.to_string(),
                                                    )
                                                }
                                            };
                                        if let Err(error) = stream.write_all(&meter_on) {
                                            return ConnectionOutcome::Retry(format!(
                                                "MeterOn write failed: {error}"
                                            ));
                                        }
                                        meter_enabled_at = Some(Instant::now());
                                    }
                                }
                                COMMAND_METER_DATA => {
                                    let Some(state) = system_state else {
                                        continue;
                                    };
                                    if midi_channel != state.midi_channel || !synced {
                                        continue;
                                    }
                                    match parse_qu16_meter_reply(sysex) {
                                        Ok(data) => {
                                            invalid_meter_frames = 0;
                                            last_meter_at = Some(Instant::now());
                                            *frame_sequence = frame_sequence.saturating_add(1);
                                            publish_snapshot(
                                                inner,
                                                callback,
                                                session_id,
                                                Qu16MeterSnapshot::live(
                                                    host.to_string(),
                                                    state.midi_channel,
                                                    state.firmware(),
                                                    *frame_sequence,
                                                    data,
                                                    session_id,
                                                ),
                                            );
                                        }
                                        Err(error) => {
                                            invalid_meter_frames += 1;
                                            if invalid_meter_frames
                                                >= MAX_CONSECUTIVE_BAD_METER_FRAMES
                                            {
                                                return ConnectionOutcome::Retry(format!(
                                                    "three invalid Qu-16 meter frames: {error}"
                                                ));
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        MidiMessage::Channel(_) => {
                            if let Some(observer) = control_observer.as_mut() {
                                match observer.push(&message) {
                                    Ok(Some(observation)) => observations.push(observation),
                                    Ok(None) => {}
                                    Err(error) if !synced => {
                                        return ConnectionOutcome::Retry(format!(
                                            "NRPN decode failed during Qu-16 sync: {error}"
                                        ));
                                    }
                                    Err(_) => observer.reset(),
                                }
                            }
                        }
                        MidiMessage::Realtime(_) => {}
                    }
                }

                if !observations.is_empty() {
                    reconcile_pending_observations(&mut pending_writes, &observations);
                    update_parameter_snapshot(
                        inner,
                        parameter_callback,
                        session_id,
                        connection_epoch,
                        |snapshot| {
                            apply_parameter_observations(snapshot, &observations);
                            true
                        },
                    );
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(error) => {
                return ConnectionOutcome::Retry(format!("Qu-16 TCP read failed: {error}"));
            }
        }

        if system_state.is_none() && started.elapsed() >= SYSTEM_REPLY_TIMEOUT {
            return ConnectionOutcome::Retry("Get System State reply timed out".into());
        }
        if system_state.is_some() && !synced && started.elapsed() >= END_SYNC_TIMEOUT {
            return ConnectionOutcome::Retry("Qu-16 End Sync reply timed out".into());
        }
        if let Some(enabled_at) = meter_enabled_at {
            if last_meter_at.is_none() && enabled_at.elapsed() >= FIRST_METER_TIMEOUT {
                return ConnectionOutcome::Retry("first Qu-16 meter frame timed out".into());
            }
        }
        if let Some(last_meter) = last_meter_at {
            if last_meter.elapsed() >= METER_STALE_TIMEOUT {
                return ConnectionOutcome::Retry(
                    "Qu-16 meter stream became stale; live values were cleared".into(),
                );
            }
        }
    }
}

fn set_pending_stage(
    snapshot: &mut Qu16ParameterSnapshot,
    keys: &[String],
    stage: Qu16PendingStage,
) {
    for key in keys {
        if let Some(pending) = snapshot.pending_details.get_mut(key) {
            pending.state = stage;
        }
    }
    snapshot.pending = snapshot.pending_details.len();
}

fn apply_parameter_observations(
    snapshot: &mut Qu16ParameterSnapshot,
    observations: &[Qu16ControlObservation],
) {
    for observation in observations {
        snapshot
            .parameters
            .insert(observation.key.clone(), observation.value.as_raw_value());
        // Hardware readback is authoritative whether it matches or conflicts
        // with the requested value.
        snapshot.pending_details.remove(&observation.key);
    }
    snapshot.pending = snapshot.pending_details.len();
}

fn complete_parameter_sync(
    snapshot: &mut Qu16ParameterSnapshot,
    observations: &[Qu16ControlObservation],
) {
    apply_parameter_observations(snapshot, observations);
    snapshot.connected = true;
    snapshot.synced = true;
    snapshot.error = None;
}

fn reset_control_observer(observer: &mut Option<Qu16ControlObserver>) {
    if let Some(observer) = observer.as_mut() {
        observer.reset();
    }
}

fn reconcile_pending_observations(
    pending_writes: &mut BTreeMap<String, PendingWrite>,
    observations: &[Qu16ControlObservation],
) {
    for observation in observations {
        // Matching and conflicting feedback have identical lifecycle
        // semantics: either way, the mixer readback is authoritative.
        let _matched_expected_value = pending_writes
            .remove(&observation.key)
            .is_some_and(|pending| pending.expected_value == observation.value.as_raw_value());
    }
}

fn mark_batch_awaiting_readback(snapshot: &mut Qu16ParameterSnapshot, batch: &ControlWriteBatch) {
    for write in &batch.writes {
        snapshot.pending_details.insert(
            write.key.clone(),
            Qu16PendingParameter {
                state: Qu16PendingStage::AwaitingReadback,
                expected_value: write.expected_value,
            },
        );
    }
    snapshot.pending = snapshot.pending_details.len();
}

fn service_control_batches(
    stream: &mut TcpStream,
    writes: &Receiver<ControlWriteBatch>,
    inner: &Arc<RuntimeInner>,
    callback: &ParameterCallback,
    session_id: u64,
    connection_epoch: u64,
    system_state: Option<Qu16SystemState>,
    synced: bool,
    pending_writes: &mut BTreeMap<String, PendingWrite>,
) -> Result<(), String> {
    for _ in 0..MAX_CONTROL_BATCHES_PER_TICK {
        let batch = match writes.try_recv() {
            Ok(batch) => batch,
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                return Err("Qu-16 control write queue disconnected".into())
            }
        };

        if batch.session_id != session_id || batch.connection_epoch != connection_epoch {
            // A command that crossed a reconnect boundary is intentionally
            // dropped; it can never be replayed on the new connection.
            continue;
        }
        let Some(state) = system_state else {
            continue;
        };
        if !synced {
            continue;
        }

        // Validate/encode the whole already-semantic batch before the single
        // TCP write. Invalid input cannot partially reach the mixer.
        let mut bytes = Vec::with_capacity(batch.writes.len() * 12);
        for write in &batch.writes {
            let encoded = write
                .command
                .encode(state.midi_channel)
                .map_err(|error| format!("Qu-16 control encode failed: {error}"))?;
            bytes.extend_from_slice(&encoded);
        }
        stream
            .write_all(&bytes)
            .map_err(|error| format!("Qu-16 control write failed: {error}"))?;

        let sent_at = Instant::now();
        for write in &batch.writes {
            pending_writes.insert(
                write.key.clone(),
                PendingWrite {
                    expected_value: write.expected_value,
                    sent_at,
                    stage: Qu16PendingStage::AwaitingReadback,
                },
            );
        }
        update_parameter_snapshot(inner, callback, session_id, connection_epoch, |snapshot| {
            mark_batch_awaiting_readback(snapshot, &batch);
            true
        });
    }
    Ok(())
}

fn drain_write_queue(writes: &Receiver<ControlWriteBatch>) {
    loop {
        match writes.try_recv() {
            Ok(_) => {}
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
        }
    }
}

fn connect(host: &str) -> Result<TcpStream, String> {
    let addresses: Vec<_> = (host, QU16_TCP_PORT)
        .to_socket_addrs()
        .map_err(|error| format!("cannot resolve {host}:{QU16_TCP_PORT}: {error}"))?
        .collect();
    if addresses.is_empty() {
        return Err(format!("{host} resolved to no TCP address"));
    }
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(READ_TIMEOUT))
                    .map_err(|error| format!("cannot set TCP read timeout: {error}"))?;
                stream
                    .set_write_timeout(Some(WRITE_TIMEOUT))
                    .map_err(|error| format!("cannot set TCP write timeout: {error}"))?;
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "cannot connect to {host}:{QU16_TCP_PORT}: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown connection error".into())
    ))
}

fn publish_snapshot(
    inner: &Arc<RuntimeInner>,
    callback: &SnapshotCallback,
    session_id: u64,
    snapshot: Qu16MeterSnapshot,
) {
    {
        let mut current = lock_unpoisoned(&inner.snapshot);
        if inner.generation.load(Ordering::Acquire) != session_id {
            return;
        }
        *current = snapshot.clone();
    }
    if inner.generation.load(Ordering::Acquire) != session_id {
        return;
    }
    // An application event sink must not be able to kill the TCP worker.
    let _ = catch_unwind(AssertUnwindSafe(|| callback(snapshot)));
}

fn publish_parameter_replacement(
    inner: &Arc<RuntimeInner>,
    callback: &ParameterCallback,
    session_id: u64,
    host: impl Into<String>,
    connection_epoch: u64,
    error: Option<String>,
) {
    let snapshot = {
        let mut current = lock_unpoisoned(&inner.parameter_snapshot);
        if inner.generation.load(Ordering::Acquire) != session_id {
            return;
        }
        let revision = current.revision.saturating_add(1);
        *current =
            Qu16ParameterSnapshot::cleared(host, session_id, revision, connection_epoch, error);
        current.clone()
    };
    if inner.generation.load(Ordering::Acquire) != session_id {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| callback(snapshot)));
}

fn update_parameter_snapshot<F>(
    inner: &Arc<RuntimeInner>,
    callback: &ParameterCallback,
    session_id: u64,
    connection_epoch: u64,
    update: F,
) where
    F: FnOnce(&mut Qu16ParameterSnapshot) -> bool,
{
    let snapshot = {
        let mut current = lock_unpoisoned(&inner.parameter_snapshot);
        if inner.generation.load(Ordering::Acquire) != session_id
            || current.session_id != session_id
            || current.connection_epoch != connection_epoch
            || !update(&mut current)
        {
            return;
        }
        current.pending = current.pending_details.len();
        current.revision = current.revision.saturating_add(1);
        current.updated_at_ms = unix_time_ms();
        current.clone()
    };
    if inner.generation.load(Ordering::Acquire) != session_id {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| callback(snapshot)));
}

fn stop_requested(stop: &Receiver<()>) -> bool {
    match stop.try_recv() {
        Ok(()) | Err(TryRecvError::Disconnected) => true,
        Err(TryRecvError::Empty) => false,
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn encode_7bitized(raw: &[u8]) -> Vec<u8> {
        let mut encoded = Vec::new();
        for group in raw.chunks(7) {
            let mut high_bits = 0_u8;
            for (index, value) in group.iter().copied().enumerate() {
                high_bits |= ((value >> 7) & 1) << (6 - index);
            }
            encoded.push(high_bits);
            encoded.extend(group.iter().map(|value| value & 0x7F));
        }
        encoded
    }

    fn set_dbfs(raw: &mut [u8], index: usize, dbfs: f32) {
        let fixed = ((dbfs * 256.0).round() as i32 + 0x8000) as u16;
        raw[index * 2..index * 2 + 2].copy_from_slice(&fixed.to_be_bytes());
    }

    fn synthetic_meter_reply() -> Vec<u8> {
        let mut raw = vec![0_u8; QU16_METER_RAW_BYTE_COUNT];
        for index in 0..QU16_METER_VALUE_COUNT {
            set_dbfs(&mut raw, index, METER_SILENCE_DBFS);
        }

        // CH1 processing: Post Delay is the level; Post Compressor is peak.
        set_dbfs(&mut raw, 0, -10.0);
        set_dbfs(&mut raw, 1, -7.0);
        set_dbfs(&mut raw, 2, -4.0);
        set_dbfs(&mut raw, 3, -6.0);

        // ST1 starts after 16 mono blocks and 80 unused values.
        let st1 = 16 * MONO_INPUT_BLOCK_METERS + QU16_UNUSED_AFTER_MONO_INPUTS;
        set_dbfs(&mut raw, st1, -2.0);
        set_dbfs(&mut raw, st1 + 3, -9.0);
        set_dbfs(&mut raw, st1 + 13, -5.0);

        let mono_mix_start =
            st1 + QU16_STEREO_INPUTS * STEREO_INPUT_BLOCK_METERS + QU16_UNUSED_AFTER_STEREO_INPUTS;
        set_dbfs(&mut raw, mono_mix_start + 5, -3.0);

        let stereo_mix_start = mono_mix_start + QU16_MONO_MIXES * MONO_MIX_BLOCK_METERS;
        let lr = stereo_mix_start + 3 * STEREO_MIX_BLOCK_METERS;
        set_dbfs(&mut raw, lr + 5, -2.0);
        set_dbfs(&mut raw, lr + 15, -1.0);

        let monitor = stereo_mix_start + QU16_STEREO_MIXES * STEREO_MIX_BLOCK_METERS;
        set_dbfs(&mut raw, monitor, -8.0);
        set_dbfs(&mut raw, monitor + 1, -9.0);
        set_dbfs(&mut raw, monitor + 2, -7.0);
        set_dbfs(&mut raw, monitor + 7, -1.0);
        set_dbfs(&mut raw, monitor + 8, -2.0);
        set_dbfs(&mut raw, monitor + 16, -30.0);
        set_dbfs(&mut raw, monitor + 47, -25.0);
        let fx1 = monitor + STEREO_MONITOR_BLOCK_METERS;
        set_dbfs(&mut raw, fx1, -12.0);
        set_dbfs(&mut raw, fx1 + 1, -10.0);
        set_dbfs(&mut raw, fx1 + 2, -9.0);
        set_dbfs(&mut raw, fx1 + 3, -8.0);
        set_dbfs(&mut raw, fx1 + 4, -7.0);
        set_dbfs(&mut raw, fx1 + 7, -6.0);
        set_dbfs(&mut raw, fx1 + 8, -5.0);

        let mut message = Vec::new();
        message.extend_from_slice(&QU_SYSEX_PREFIX);
        message.extend_from_slice(&[0x03, COMMAND_METER_DATA]);
        message.extend_from_slice(&encode_7bitized(&raw));
        message.push(SYSEX_END);
        message
    }

    #[test]
    fn builds_all_call_then_channel_specific_meter_requests() {
        assert_eq!(
            build_get_system_state_request(),
            vec![0xF0, 0x00, 0x00, 0x1A, 0x50, 0x11, 0x01, 0x00, 0x7F, 0x10, 0x01, 0xF7]
        );
        assert_eq!(
            build_meter_request(0x03, true).unwrap(),
            vec![0xF0, 0x00, 0x00, 0x1A, 0x50, 0x11, 0x01, 0x00, 0x03, 0x12, 0x01, 0xF7]
        );
        assert_eq!(
            build_meter_request(0x10, true).unwrap_err(),
            Qu16ProtocolError::InvalidSysex("MIDI channel must be in the range 0..15")
        );
    }

    #[test]
    fn parses_qu16_system_state_and_rejects_other_models() {
        let mut reply = QU_SYSEX_PREFIX.to_vec();
        reply.extend_from_slice(&[0x03, 0x11, 0x01, 0x01, 0x09, 0xF7]);
        assert_eq!(
            parse_system_state_reply(&reply).unwrap(),
            Qu16SystemState {
                midi_channel: 3,
                box_id: 1,
                firmware_major: 1,
                firmware_minor: 9,
            }
        );
        reply[10] = 2;
        assert_eq!(
            parse_system_state_reply(&reply).unwrap_err(),
            Qu16ProtocolError::UnsupportedMixer { box_id: 2 }
        );
    }

    #[test]
    fn decodes_protocol_7q8_example() {
        let raw = decode_7bitized(&[0b0010_0000, 0x7C, 0x00]).unwrap();
        assert_eq!(raw, vec![0x7C, 0x80]);
        assert_eq!(decode_7q8_dbfs([raw[0], raw[1]]), -3.5);
    }

    #[test]
    fn seven_bit_round_trip_handles_full_and_short_groups() {
        let raw = vec![0x00, 0x80, 0x7F, 0xFF, 0x42, 0xC3, 0x12, 0x99, 0x01];
        assert_eq!(decode_7bitized(&encode_7bitized(&raw)).unwrap(), raw);
    }

    #[test]
    fn parses_qu16_blocks_into_frontend_ids() {
        let frame = parse_qu16_meter_reply(&synthetic_meter_reply()).unwrap();
        assert_eq!(frame.channels["ch-1"].level_dbfs, -6.0);
        assert_eq!(frame.channels["ch-1"].peak_dbfs, -4.0);
        assert_eq!(frame.channels["st-1"].level_dbfs, -5.0);
        assert_eq!(frame.channels["st-1"].peak_dbfs, -2.0);
        assert_eq!(frame.channels["st-1"].left_dbfs, Some(-9.0));
        assert_eq!(frame.channels["st-1"].right_dbfs, Some(-5.0));
        assert_eq!(frame.masters["Mix 1"].level_dbfs, -3.0);
        assert_eq!(frame.masters["LR"].left_dbfs, Some(-2.0));
        assert_eq!(frame.masters["LR"].right_dbfs, Some(-1.0));
        assert_eq!(frame.masters["FX 1"].left_dbfs, Some(-12.0));
        assert_eq!(frame.masters["FX 1"].right_dbfs, Some(-10.0));
        assert_eq!(frame.masters["FX 1"].level_dbfs, -9.0);
        assert_eq!(
            frame.masters["FX 1"].meter_role.as_deref(),
            Some("rack-fx-input")
        );
        assert_eq!(frame.channels["fx-1-ret"].left_dbfs, Some(-6.0));
        assert_eq!(frame.channels["fx-1-ret"].right_dbfs, Some(-5.0));
        assert_eq!(frame.channels["fx-1-ret"].peak_dbfs, -5.0);
        assert_eq!(frame.monitor.left_dbfs, -8.0);
        assert_eq!(frame.monitor.right_dbfs, -9.0);
        assert_eq!(frame.monitor.main_left_dbfs, -1.0);
        assert_eq!(frame.monitor.main_right_dbfs, -2.0);
        assert_eq!(frame.rta_dbfs.len(), 31);
        assert_eq!(frame.rta_dbfs[0], -25.0);
    }

    #[test]
    fn rejects_wrong_meter_payload_length() {
        let mut message = synthetic_meter_reply();
        message.remove(message.len() - 2);
        assert!(matches!(
            parse_qu16_meter_reply(&message),
            Err(Qu16ProtocolError::MeterPayloadSize { .. })
        ));
    }

    #[test]
    fn midi_decoder_handles_fragmented_sysex_and_interleaved_active_sense() {
        let mut decoder = MidiStreamDecoder::default();
        assert_eq!(
            decoder.push(&[SYSEX_START, 0x00, ACTIVE_SENSE]),
            vec![Ok(MidiMessage::Realtime(ACTIVE_SENSE))]
        );
        assert_eq!(
            decoder.push(&[0x01, SYSEX_END, ACTIVE_SENSE]),
            vec![
                Ok(MidiMessage::SysEx(vec![SYSEX_START, 0x00, 0x01, SYSEX_END])),
                Ok(MidiMessage::Realtime(ACTIVE_SENSE)),
            ]
        );
    }

    #[test]
    fn disconnected_snapshot_is_explicit_and_clears_all_meters() {
        let snapshot = Qu16MeterSnapshot::cleared(
            "192.0.2.10",
            Qu16ConnectionState::Reconnecting,
            Some("test disconnect".into()),
            7,
        );
        assert!(!snapshot.connected);
        assert_eq!(snapshot.source, QU16_METER_SOURCE);
        assert_eq!(snapshot.channels.len(), 23);
        assert_eq!(snapshot.masters.len(), 10);
        assert!(snapshot
            .channels
            .values()
            .all(|meter| meter.level_dbfs == METER_SILENCE_DBFS));
        assert!(snapshot
            .masters
            .values()
            .all(|meter| meter.level_dbfs == METER_SILENCE_DBFS));
        assert!(snapshot
            .rta_dbfs
            .iter()
            .all(|level| *level == METER_SILENCE_DBFS));
    }

    #[test]
    fn snapshot_serializes_to_frontend_contract() {
        let snapshot =
            Qu16MeterSnapshot::cleared("192.0.2.10", Qu16ConnectionState::Stopped, None, 9);
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["source"], QU16_METER_SOURCE);
        assert_eq!(json["sessionId"], 9);
        assert_eq!(json["connected"], false);
        assert!(json["updatedAtMs"].is_number());
        assert!(json["channels"]["ch-1"]["levelDbfs"].is_number());
        assert!(json["channels"]["st-1"]["leftDbfs"].is_number());
        assert!(json["masters"]["LR"]["leftDbfs"].is_number());
        assert!(json["monitor"]["leftDbfs"].is_number());
        assert_eq!(json["rtaDbfs"].as_array().unwrap().len(), 31);
    }

    #[test]
    fn parameter_snapshot_serializes_plain_map_pending_count_and_camel_case() {
        let mut snapshot = Qu16ParameterSnapshot::cleared("192.0.2.20", 15, 7, 3, None);
        snapshot.connected = true;
        snapshot.synced = true;
        snapshot.parameters.insert("fader:ch-1".into(), 98);
        snapshot.pending_details.insert(
            "mute:ch-1".into(),
            Qu16PendingParameter {
                state: Qu16PendingStage::AwaitingReadback,
                expected_value: 1,
            },
        );
        snapshot.pending = 1;
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["host"], "192.0.2.20");
        assert_eq!(json["sessionId"], 15);
        assert_eq!(json["connected"], true);
        assert_eq!(json["synced"], true);
        assert_eq!(json["revision"], 7);
        assert_eq!(json["parameters"]["fader:ch-1"], 98);
        assert_eq!(json["pending"], 1);
        assert_eq!(
            json["pendingDetails"]["mute:ch-1"]["state"],
            "awaiting-readback"
        );
        assert_eq!(json["connectionEpoch"], 3);
    }

    #[test]
    fn end_sync_publishes_prior_same_read_observations_atomically() {
        use crate::qu16_control::{Qu16ObservedControl, Qu16ObservedValue};

        let runtime = Qu16Runtime::new();
        runtime.inner.generation.store(31, Ordering::Release);
        *lock_unpoisoned(&runtime.inner.parameter_snapshot) =
            Qu16ParameterSnapshot::cleared("qu16", 31, 4, 2, None);
        let emitted = Arc::new(Mutex::new(Vec::<Qu16ParameterSnapshot>::new()));
        let emitted_frames = Arc::clone(&emitted);
        let callback: ParameterCallback = Arc::new(move |snapshot| {
            lock_unpoisoned(&emitted_frames).push(snapshot);
        });
        let observations = [Qu16ControlObservation {
            key: "fader:ch-1".into(),
            target_id: "ch-1".into(),
            control: Qu16ObservedControl::Fader,
            mix: None,
            value: Qu16ObservedValue::SevenBit(98),
        }];

        update_parameter_snapshot(&runtime.inner, &callback, 31, 2, |snapshot| {
            complete_parameter_sync(snapshot, &observations);
            true
        });

        let frames = lock_unpoisoned(&emitted);
        assert_eq!(frames.len(), 1);
        assert!(frames[0].connected);
        assert!(frames[0].synced);
        assert_eq!(frames[0].parameters["fader:ch-1"], 98);
    }

    #[test]
    fn decoder_error_reset_prevents_stale_nrpn_selector_reuse() {
        let mut observer = Some(Qu16ControlObserver::new(0).unwrap());
        let mut decoder = MidiStreamDecoder::default();
        for decoded in decoder.push(&[0xB0, 0x63, 0x20, 0xB0, 0x62, 0x17]) {
            let message = decoded.unwrap();
            assert!(observer.as_mut().unwrap().push(&message).unwrap().is_none());
        }

        reset_control_observer(&mut observer);

        let mut produced_observation = false;
        let mut rejected_missing_selector = false;
        for decoded in decoder.push(&[0xB0, 0x06, 0x62, 0xB0, 0x26, 0x07]) {
            let message = decoded.unwrap();
            match observer.as_mut().unwrap().push(&message) {
                Ok(Some(_)) => produced_observation = true,
                Ok(None) => {}
                Err(_) => rejected_missing_selector = true,
            }
        }
        assert!(rejected_missing_selector);
        assert!(!produced_observation);
    }

    #[test]
    fn control_drain_budget_cannot_starve_active_sense_deadline() {
        assert_eq!(MAX_CONTROL_BATCHES_PER_TICK, 1);
        assert!(WRITE_TIMEOUT + READ_TIMEOUT < ACTIVE_SENSE_INTERVAL);
    }

    #[test]
    fn authoritative_readback_clears_matching_or_conflicting_pending() {
        use crate::qu16_control::{Qu16ObservedControl, Qu16ObservedValue};

        let mut snapshot = Qu16ParameterSnapshot::cleared("host", 2, 1, 4, None);
        snapshot.parameters.insert("fader:ch-1".into(), 10);
        for (key, expected_value) in [("fader:ch-1", 99), ("mute:ch-1", 1)] {
            snapshot.pending_details.insert(
                key.into(),
                Qu16PendingParameter {
                    state: Qu16PendingStage::AwaitingReadback,
                    expected_value,
                },
            );
        }
        snapshot.pending = 2;
        let observations = [Qu16ControlObservation {
            key: "fader:ch-1".into(),
            target_id: "ch-1".into(),
            control: Qu16ObservedControl::Fader,
            mix: None,
            // Conflicts with expected 99; hardware value 80 still wins.
            value: Qu16ObservedValue::SevenBit(80),
        }];
        apply_parameter_observations(&mut snapshot, &observations);
        assert_eq!(snapshot.parameters["fader:ch-1"], 80);
        assert!(!snapshot.pending_details.contains_key("fader:ch-1"));
        assert_eq!(snapshot.pending, 1);

        set_pending_stage(
            &mut snapshot,
            &["mute:ch-1".into()],
            Qu16PendingStage::SentUnconfirmed,
        );
        assert_eq!(
            snapshot.pending_details["mute:ch-1"].state,
            Qu16PendingStage::SentUnconfirmed
        );
    }

    #[test]
    fn write_batch_is_atomic_duplicate_safe_and_queued_before_worker_transition() {
        let runtime = Qu16Runtime::new();
        let session_id = 21;
        runtime
            .inner
            .generation
            .store(session_id, Ordering::Release);
        let mut ready = Qu16ParameterSnapshot::cleared("qu16", session_id, 4, 8, None);
        ready.connected = true;
        ready.synced = true;
        *lock_unpoisoned(&runtime.inner.parameter_snapshot) = ready;

        let (stop_sender, stop_receiver) = mpsc::channel();
        let (write_sender, write_receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);
        let join = thread::spawn(move || {
            let _ = stop_receiver.recv();
        });
        *lock_unpoisoned(&runtime.inner.worker) = Some(WorkerControl {
            stop: stop_sender,
            writes: write_sender,
            join,
        });

        let duplicate = runtime.write_parameters(
            session_id,
            vec![
                Qu16ParameterWrite {
                    key: "fader:ch-1".into(),
                    value: 10,
                },
                Qu16ParameterWrite {
                    key: "fader:ch-1".into(),
                    value: 11,
                },
            ],
        );
        assert!(matches!(
            duplicate,
            Err(Qu16RuntimeError::DuplicateParameterKey(_))
        ));
        assert!(matches!(
            write_receiver.try_recv(),
            Err(TryRecvError::Empty)
        ));

        let invalid = runtime.write_parameters(
            session_id,
            vec![
                Qu16ParameterWrite {
                    key: "mute:ch-1".into(),
                    value: 1,
                },
                Qu16ParameterWrite {
                    key: "raw-nrpn:95".into(),
                    value: 1,
                },
            ],
        );
        assert!(matches!(invalid, Err(Qu16RuntimeError::InvalidControl(_))));
        assert!(matches!(
            write_receiver.try_recv(),
            Err(TryRecvError::Empty)
        ));

        let queued = runtime
            .write_parameters(
                session_id,
                vec![
                    Qu16ParameterWrite {
                        key: "fader:ch-1".into(),
                        value: 98,
                    },
                    Qu16ParameterWrite {
                        key: "send:ch-1:Mix 1".into(),
                        value: 64,
                    },
                    Qu16ParameterWrite {
                        key: "mute:ch-1".into(),
                        value: 1,
                    },
                    Qu16ParameterWrite {
                        key: "pafl:lr-master".into(),
                        value: 0,
                    },
                ],
            )
            .unwrap();
        assert_eq!(queued.pending, 4);
        assert!(queued
            .pending_details
            .values()
            .all(|pending| pending.state == Qu16PendingStage::Queued));
        let batch = write_receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        assert_eq!(batch.session_id, session_id);
        assert_eq!(batch.connection_epoch, 8);
        assert_eq!(batch.writes.len(), 4);
        let mut awaiting = queued.clone();
        mark_batch_awaiting_readback(&mut awaiting, &batch);
        assert!(awaiting
            .pending_details
            .values()
            .all(|pending| pending.state == Qu16PendingStage::AwaitingReadback));

        runtime.stop_metering();
    }

    #[test]
    fn parameter_updates_reject_stale_session_and_connection_epoch() {
        let runtime = Qu16Runtime::new();
        runtime.inner.generation.store(5, Ordering::Release);
        *lock_unpoisoned(&runtime.inner.parameter_snapshot) =
            Qu16ParameterSnapshot::cleared("current", 5, 2, 9, None);
        let emitted = Arc::new(AtomicUsize::new(0));
        let emitted_callback = Arc::clone(&emitted);
        let callback: ParameterCallback = Arc::new(move |_| {
            emitted_callback.fetch_add(1, Ordering::Relaxed);
        });

        update_parameter_snapshot(&runtime.inner, &callback, 4, 9, |_| true);
        update_parameter_snapshot(&runtime.inner, &callback, 5, 8, |_| true);
        assert_eq!(runtime.parameter_status().revision, 2);
        assert_eq!(emitted.load(Ordering::Relaxed), 0);

        update_parameter_snapshot(&runtime.inner, &callback, 5, 9, |snapshot| {
            snapshot.connected = true;
            true
        });
        assert_eq!(runtime.parameter_status().revision, 3);
        assert_eq!(emitted.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn stale_worker_generation_cannot_overwrite_or_emit() {
        let runtime = Qu16Runtime::new();
        runtime.inner.generation.store(2, Ordering::Release);
        let callback_count = Arc::new(AtomicUsize::new(0));
        let callback_counter = Arc::clone(&callback_count);
        let callback: SnapshotCallback = Arc::new(move |_| {
            callback_counter.fetch_add(1, Ordering::Relaxed);
        });

        publish_snapshot(
            &runtime.inner,
            &callback,
            1,
            Qu16MeterSnapshot::cleared("old-host", Qu16ConnectionState::Stopped, None, 1),
        );
        assert_ne!(runtime.meter_status().host, "old-host");
        assert_eq!(callback_count.load(Ordering::Relaxed), 0);

        publish_snapshot(
            &runtime.inner,
            &callback,
            2,
            Qu16MeterSnapshot::cleared("current-host", Qu16ConnectionState::Connecting, None, 2),
        );
        assert_eq!(runtime.meter_status().host, "current-host");
        assert_eq!(callback_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn stale_cleanup_cannot_stop_a_newer_session() {
        let runtime = Qu16Runtime::new();
        runtime.inner.generation.store(12, Ordering::Release);
        *lock_unpoisoned(&runtime.inner.snapshot) =
            Qu16MeterSnapshot::cleared("new-host", Qu16ConnectionState::Connecting, None, 12);

        let snapshot = runtime.stop_metering_if(11);
        assert_eq!(snapshot.session_id, 12);
        assert_eq!(snapshot.host, "new-host");
        assert_eq!(runtime.inner.generation.load(Ordering::Acquire), 12);
    }
}
