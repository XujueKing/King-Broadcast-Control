use crate::{
    capture::MeterFrame,
    qu16_meter::{
        Qu16MeterConnectionState, Qu16MeterEnvelope, Qu16MeterRejection, Qu16ReturnMeterAdapter,
        Qu16TcpMeterSnapshot,
    },
    EngineError,
};
use serde::Serialize;
use serde_json::{json, Value};

const BRIDGE_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_AGE_MS: u64 = 250;
const FRAMES_PER_MILLISECOND: u64 = 48;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQu16MeterBridgeStatus {
    pub schema_version: u32,
    pub mode: &'static str,
    pub session_id: u64,
    pub connection_generation: u64,
    pub connected: bool,
    pub evidence_live: bool,
    pub state: Qu16MeterConnectionState,
    pub snapshot_age_ms: Option<u64>,
    pub last_frame_sequence: Option<u64>,
    pub last_sample_frame_position: Option<u64>,
    pub accepted_snapshots: usize,
    pub rejected_snapshots: usize,
    pub last_rejection: Option<Qu16MeterRejection>,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub hardware_ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQu16MeterBridgeUpdate {
    pub status: DesktopQu16MeterBridgeStatus,
    pub frame: Option<MeterFrame>,
}

pub struct DesktopQu16MeterBridge {
    status: DesktopQu16MeterBridgeStatus,
    adapter: Option<Qu16ReturnMeterAdapter>,
    renew_on_metering: bool,
    max_age_ms: u64,
}

impl Default for DesktopQu16MeterBridge {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_AGE_MS)
    }
}

impl DesktopQu16MeterBridge {
    pub fn new(max_age_ms: u64) -> Self {
        Self {
            status: DesktopQu16MeterBridgeStatus {
                schema_version: BRIDGE_SCHEMA_VERSION,
                mode: "desktop_qu16_live_meter_bridge",
                session_id: 0,
                connection_generation: 0,
                connected: false,
                evidence_live: false,
                state: Qu16MeterConnectionState::Stopped,
                snapshot_age_ms: None,
                last_frame_sequence: None,
                last_sample_frame_position: None,
                accepted_snapshots: 0,
                rejected_snapshots: 0,
                last_rejection: None,
                output_stream_started: false,
                qu16_writes_performed: false,
                hardware_ready: false,
            },
            adapter: None,
            renew_on_metering: false,
            max_age_ms,
        }
    }

    pub fn status(&self) -> DesktopQu16MeterBridgeStatus {
        self.status.clone()
    }

    /// Accepts the JSON representation emitted by the desktop Qu-16 runtime.
    /// `updatedAtMs` is projected onto a shared 48 kHz wall-clock timeline;
    /// P24 will anchor the USB input source to the same epoch.
    pub fn ingest_json(
        &mut self,
        value: Value,
        now_ms: u64,
    ) -> Result<DesktopQu16MeterBridgeUpdate, EngineError> {
        let snapshot: Qu16TcpMeterSnapshot = serde_json::from_value(value)
            .map_err(|error| EngineError(format!("Qu-16 desktop snapshot is invalid: {error}")))?;

        if snapshot.session_id != self.status.session_id
            || (snapshot.state == Qu16MeterConnectionState::Metering && self.renew_on_metering)
        {
            self.begin_generation(snapshot.session_id);
            self.renew_on_metering = false;
        }

        let age = now_ms.checked_sub(snapshot.updated_at_ms);
        self.status.connected = snapshot.connected;
        self.status.state = snapshot.state;
        self.status.snapshot_age_ms = age;
        let envelope = Qu16MeterEnvelope {
            connection_generation: self.status.connection_generation,
            sample_frame_position: snapshot
                .updated_at_ms
                .saturating_mul(FRAMES_PER_MILLISECOND),
            snapshot,
        };
        let result = self
            .adapter
            .as_mut()
            .expect("a session always creates an adapter")
            .ingest(&envelope, now_ms);
        let frame = match result {
            Ok(frame) => {
                self.status.accepted_snapshots += 1;
                self.status.evidence_live = true;
                self.status.last_rejection = None;
                self.status.last_frame_sequence = Some(frame.sequence);
                self.status.last_sample_frame_position = Some(frame.frame_position);
                Some(frame)
            }
            Err(rejection) => {
                self.status.rejected_snapshots += 1;
                self.status.evidence_live = false;
                self.status.last_rejection = Some(rejection);
                None
            }
        };

        if matches!(
            envelope.snapshot.state,
            Qu16MeterConnectionState::Reconnecting
                | Qu16MeterConnectionState::Stopped
                | Qu16MeterConnectionState::Error
        ) {
            if let Some(adapter) = &mut self.adapter {
                adapter.disconnect();
            }
            self.renew_on_metering = true;
            self.status.connected = false;
            self.status.evidence_live = false;
            self.status.last_frame_sequence = None;
            self.status.last_sample_frame_position = None;
        }

        Ok(DesktopQu16MeterBridgeUpdate {
            status: self.status(),
            frame,
        })
    }

    fn begin_generation(&mut self, session_id: u64) {
        self.status.session_id = session_id;
        self.status.connection_generation = self.status.connection_generation.saturating_add(1);
        self.status.last_frame_sequence = None;
        self.status.last_sample_frame_position = None;
        self.adapter = Some(Qu16ReturnMeterAdapter::new(
            session_id,
            self.status.connection_generation,
            self.max_age_ms,
        ));
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQu16MeterBridgeReplayReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub updates: Vec<DesktopQu16MeterBridgeStatus>,
    pub final_status: DesktopQu16MeterBridgeStatus,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub hardware_ready: bool,
}

pub fn run_default_desktop_qu16_meter_bridge_replay(
) -> Result<DesktopQu16MeterBridgeReplayReport, EngineError> {
    let now_ms = 1_000_000;
    let mut bridge = DesktopQu16MeterBridge::default();
    let snapshots = [
        native_snapshot(51, false, "connecting", now_ms, 0, -128.0),
        native_snapshot(51, true, "metering", now_ms, 1, -11.0),
        native_snapshot(51, false, "reconnecting", now_ms + 10, 0, -128.0),
        native_snapshot(51, true, "metering", now_ms + 20, 1, -10.0),
        native_snapshot(51, true, "metering", now_ms - 300, 2, -9.0),
    ];
    let updates = snapshots
        .into_iter()
        .map(|snapshot| {
            bridge
                .ingest_json(snapshot, now_ms + 20)
                .map(|update| update.status)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DesktopQu16MeterBridgeReplayReport {
        schema_version: BRIDGE_SCHEMA_VERSION,
        mode: "recorded_desktop_qu16_meter_bridge_replay",
        final_status: bridge.status(),
        updates,
        output_stream_started: false,
        qu16_writes_performed: false,
        hardware_ready: false,
    })
}

fn native_snapshot(
    session_id: u64,
    connected: bool,
    state: &str,
    updated_at_ms: u64,
    frame_sequence: u64,
    peak_dbfs: f32,
) -> Value {
    json!({
        "source": "qu16-tcp-midi",
        "sessionId": session_id,
        "connected": connected,
        "state": state,
        "updatedAtMs": updated_at_ms,
        "frameSequence": frame_sequence,
        "host": "192.0.2.10",
        "channels": {
            "ch-1": {"levelDbfs": peak_dbfs, "peakDbfs": peak_dbfs},
            "ch-16": {"levelDbfs": -81.0, "peakDbfs": -81.0}
        },
        "masters": {},
        "monitor": {},
        "rtaDbfs": []
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metering_snapshot_becomes_a_read_only_return_frame() {
        let mut bridge = DesktopQu16MeterBridge::default();
        let update = bridge
            .ingest_json(native_snapshot(3, true, "metering", 1_000, 7, -12.0), 1_020)
            .unwrap();
        assert_eq!(update.frame.unwrap().frame_position, 48_000);
        assert_eq!(update.status.accepted_snapshots, 1);
        assert!(!update.status.output_stream_started);
        assert!(!update.status.qu16_writes_performed);
    }

    #[test]
    fn reconnect_creates_a_new_generation_and_clears_old_frame() {
        let mut bridge = DesktopQu16MeterBridge::default();
        bridge
            .ingest_json(native_snapshot(3, true, "metering", 1_000, 1, -12.0), 1_000)
            .unwrap();
        let disconnected = bridge
            .ingest_json(
                native_snapshot(3, false, "reconnecting", 1_010, 0, -128.0),
                1_010,
            )
            .unwrap();
        assert!(disconnected.frame.is_none());
        assert!(disconnected.status.last_frame_sequence.is_none());
        let reconnected = bridge
            .ingest_json(native_snapshot(3, true, "metering", 1_020, 1, -11.0), 1_020)
            .unwrap();
        assert_eq!(reconnected.status.connection_generation, 2);
        assert!(reconnected.frame.is_some());
    }

    #[test]
    fn duplicate_and_stale_snapshots_fail_closed() {
        let mut bridge = DesktopQu16MeterBridge::default();
        let snapshot = native_snapshot(3, true, "metering", 1_000, 1, -12.0);
        bridge.ingest_json(snapshot.clone(), 1_000).unwrap();
        let duplicate = bridge.ingest_json(snapshot, 1_000).unwrap();
        assert_eq!(
            duplicate.status.last_rejection,
            Some(Qu16MeterRejection::NonMonotonicSequence)
        );
        let stale = bridge
            .ingest_json(native_snapshot(3, true, "metering", 1_001, 2, -11.0), 1_252)
            .unwrap();
        assert_eq!(stale.status.last_rejection, Some(Qu16MeterRejection::Stale));
        assert!(!stale.status.evidence_live);
    }

    #[test]
    fn replay_observes_reconnect_and_never_claims_hardware() {
        let report = run_default_desktop_qu16_meter_bridge_replay().unwrap();
        assert_eq!(report.updates.len(), 5);
        assert_eq!(report.final_status.connection_generation, 2);
        assert_eq!(report.final_status.accepted_snapshots, 2);
        assert_eq!(report.final_status.rejected_snapshots, 3);
        assert_eq!(
            report.final_status.last_rejection,
            Some(Qu16MeterRejection::Stale)
        );
        assert!(!report.output_stream_started);
        assert!(!report.qu16_writes_performed);
        assert!(!report.hardware_ready);
    }
}
