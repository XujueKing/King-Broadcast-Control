use crate::{
    capture::{ChannelPeak, MeterFrame, MeterReplayFixture},
    joint::{default_joint_fixtures, run_joint_replay, JointCalibrationReport},
    routing::{AsioChannelDescriptor, AsioChannelInventory, AsioDirection},
    EngineError, SAMPLE_RATE,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const ADAPTER_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_AGE_MS: u64 = 250;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Qu16MeterConnectionState {
    Stopped,
    Connecting,
    Syncing,
    Metering,
    Reconnecting,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16ChannelMeterSnapshot {
    pub level_dbfs: f32,
    pub peak_dbfs: f32,
}

/// Read-only subset of the desktop Qu-16 TCP meter snapshot. Unknown fields
/// (masters, monitor and RTA) are deliberately ignored by serde.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16TcpMeterSnapshot {
    pub source: String,
    pub session_id: u64,
    pub connected: bool,
    pub state: Qu16MeterConnectionState,
    pub updated_at_ms: u64,
    pub frame_sequence: u64,
    pub channels: BTreeMap<String, Qu16ChannelMeterSnapshot>,
}

/// Bridge metadata is kept outside the native desktop snapshot so the latter
/// remains wire-compatible with `qu16_runtime::Qu16MeterSnapshot`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MeterEnvelope {
    pub connection_generation: u64,
    pub sample_frame_position: u64,
    pub snapshot: Qu16TcpMeterSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Qu16MeterRejection {
    WrongSource,
    WrongSession,
    WrongGeneration,
    Disconnected,
    NotMetering,
    Stale,
    FutureTimestamp,
    NonMonotonicSequence,
    InvalidChannel,
    InvalidPeak,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MeterAdapterCounters {
    pub accepted: usize,
    pub rejected: usize,
    pub wrong_source: usize,
    pub wrong_session: usize,
    pub wrong_generation: usize,
    pub disconnected: usize,
    pub not_metering: usize,
    pub stale: usize,
    pub future_timestamp: usize,
    pub non_monotonic_sequence: usize,
    pub invalid_channel: usize,
    pub invalid_peak: usize,
}

pub struct Qu16ReturnMeterAdapter {
    session_id: u64,
    connection_generation: u64,
    max_age_ms: u64,
    last_sequence: Option<u64>,
    active: bool,
    counters: Qu16MeterAdapterCounters,
}

impl Qu16ReturnMeterAdapter {
    pub fn new(session_id: u64, connection_generation: u64, max_age_ms: u64) -> Self {
        Self {
            session_id,
            connection_generation,
            max_age_ms,
            last_sequence: None,
            active: true,
            counters: Qu16MeterAdapterCounters::default(),
        }
    }

    pub fn ingest(
        &mut self,
        envelope: &Qu16MeterEnvelope,
        now_ms: u64,
    ) -> Result<MeterFrame, Qu16MeterRejection> {
        let snapshot = &envelope.snapshot;
        let rejection = if snapshot.source != "qu16-tcp-midi" {
            Some(Qu16MeterRejection::WrongSource)
        } else if snapshot.session_id != self.session_id {
            Some(Qu16MeterRejection::WrongSession)
        } else if envelope.connection_generation != self.connection_generation {
            Some(Qu16MeterRejection::WrongGeneration)
        } else if !self.active || !snapshot.connected {
            Some(Qu16MeterRejection::Disconnected)
        } else if snapshot.state != Qu16MeterConnectionState::Metering {
            Some(Qu16MeterRejection::NotMetering)
        } else if snapshot.updated_at_ms > now_ms {
            Some(Qu16MeterRejection::FutureTimestamp)
        } else if now_ms - snapshot.updated_at_ms > self.max_age_ms {
            Some(Qu16MeterRejection::Stale)
        } else if self
            .last_sequence
            .is_some_and(|sequence| snapshot.frame_sequence <= sequence)
        {
            Some(Qu16MeterRejection::NonMonotonicSequence)
        } else {
            None
        };
        if let Some(rejection) = rejection {
            self.reject(rejection);
            return Err(rejection);
        }

        let mut seen = BTreeSet::new();
        let mut peaks = Vec::with_capacity(snapshot.channels.len());
        for (key, meter) in &snapshot.channels {
            let Some(driver_index) = key
                .strip_prefix("ch-")
                .and_then(|value| value.parse::<usize>().ok())
            else {
                self.reject(Qu16MeterRejection::InvalidChannel);
                return Err(Qu16MeterRejection::InvalidChannel);
            };
            if driver_index == 0 || !seen.insert(driver_index) {
                self.reject(Qu16MeterRejection::InvalidChannel);
                return Err(Qu16MeterRejection::InvalidChannel);
            }
            if !meter.peak_dbfs.is_finite() || !meter.level_dbfs.is_finite() {
                self.reject(Qu16MeterRejection::InvalidPeak);
                return Err(Qu16MeterRejection::InvalidPeak);
            }
            peaks.push(ChannelPeak {
                driver_index,
                peak_dbfs: meter.peak_dbfs,
            });
        }
        if peaks.is_empty() {
            self.reject(Qu16MeterRejection::InvalidChannel);
            return Err(Qu16MeterRejection::InvalidChannel);
        }

        self.last_sequence = Some(snapshot.frame_sequence);
        self.counters.accepted += 1;
        Ok(MeterFrame {
            sequence: snapshot.frame_sequence,
            frame_position: envelope.sample_frame_position,
            direction: AsioDirection::Output,
            peaks,
        })
    }

    pub fn disconnect(&mut self) {
        self.active = false;
        self.last_sequence = None;
    }

    pub fn counters(&self) -> &Qu16MeterAdapterCounters {
        &self.counters
    }

    fn reject(&mut self, rejection: Qu16MeterRejection) {
        self.counters.rejected += 1;
        match rejection {
            Qu16MeterRejection::WrongSource => self.counters.wrong_source += 1,
            Qu16MeterRejection::WrongSession => self.counters.wrong_session += 1,
            Qu16MeterRejection::WrongGeneration => self.counters.wrong_generation += 1,
            Qu16MeterRejection::Disconnected => self.counters.disconnected += 1,
            Qu16MeterRejection::NotMetering => self.counters.not_metering += 1,
            Qu16MeterRejection::Stale => self.counters.stale += 1,
            Qu16MeterRejection::FutureTimestamp => self.counters.future_timestamp += 1,
            Qu16MeterRejection::NonMonotonicSequence => self.counters.non_monotonic_sequence += 1,
            Qu16MeterRejection::InvalidChannel => self.counters.invalid_channel += 1,
            Qu16MeterRejection::InvalidPeak => self.counters.invalid_peak += 1,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MeterAdapterReplayReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub recorded_snapshots: usize,
    pub adapter: Qu16MeterAdapterCounters,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub joint_evidence: JointCalibrationReport,
    pub hardware_ready: bool,
}

pub fn run_default_qu16_meter_adapter_replay() -> Result<Qu16MeterAdapterReplayReport, EngineError>
{
    let (input_fixture, _) = default_joint_fixtures(false);
    let now_ms = 1_000_000;
    let session_id = 41;
    let generation = 7;
    let snapshots = [
        recorded_snapshot(session_id, generation - 1, 1, now_ms, 4_800, 1, -11.0),
        recorded_snapshot(
            session_id,
            generation,
            2,
            now_ms - DEFAULT_MAX_AGE_MS - 1,
            4_800,
            1,
            -11.0,
        ),
        recorded_snapshot(session_id, generation, 3, now_ms, 4_920, 1, -11.0),
        recorded_snapshot(session_id, generation, 4, now_ms, 9_720, 4, -11.0),
        recorded_snapshot(session_id, generation, 5, now_ms, 14_520, 8, -11.0),
    ];
    let mut adapter = Qu16ReturnMeterAdapter::new(session_id, generation, DEFAULT_MAX_AGE_MS);
    let frames = snapshots
        .iter()
        .filter_map(|snapshot| adapter.ingest(snapshot, now_ms).ok())
        .collect();
    let return_fixture = MeterReplayFixture {
        schema_version: 1,
        name: "recorded_qu16_tcp_meter_adapter".into(),
        inventory: AsioChannelInventory {
            driver_name: "Recorded Qu-16 TCP Meter Adapter".into(),
            sample_rate: SAMPLE_RATE,
            physical_hardware: false,
            input_channels: Vec::new(),
            output_channels: [
                (1, "Qu-16 Return A"),
                (4, "Qu-16 Return B"),
                (8, "Qu-16 Return C"),
            ]
            .into_iter()
            .map(|(driver_index, name)| AsioChannelDescriptor {
                driver_index,
                name: name.into(),
                direction: AsioDirection::Output,
            })
            .collect(),
        },
        frames,
        physical_capture: false,
    };
    let recorded_snapshots = snapshots.len();
    let counters = adapter.counters().clone();
    let joint_evidence = run_joint_replay(input_fixture, return_fixture)?;
    Ok(Qu16MeterAdapterReplayReport {
        schema_version: ADAPTER_SCHEMA_VERSION,
        mode: "recorded_qu16_tcp_meter_adapter_replay",
        recorded_snapshots,
        adapter: counters,
        output_stream_started: false,
        qu16_writes_performed: false,
        joint_evidence,
        hardware_ready: false,
    })
}

fn recorded_snapshot(
    session_id: u64,
    connection_generation: u64,
    frame_sequence: u64,
    updated_at_ms: u64,
    frame_position: u64,
    channel: usize,
    peak_dbfs: f32,
) -> Qu16MeterEnvelope {
    Qu16MeterEnvelope {
        connection_generation,
        sample_frame_position: frame_position,
        snapshot: Qu16TcpMeterSnapshot {
            source: "qu16-tcp-midi".into(),
            session_id,
            connected: true,
            state: Qu16MeterConnectionState::Metering,
            updated_at_ms,
            frame_sequence,
            channels: [
                (
                    format!("ch-{channel}"),
                    Qu16ChannelMeterSnapshot {
                        level_dbfs: peak_dbfs,
                        peak_dbfs,
                    },
                ),
                (
                    "ch-16".into(),
                    Qu16ChannelMeterSnapshot {
                        level_dbfs: -81.0,
                        peak_dbfs: -81.0,
                    },
                ),
            ]
            .into_iter()
            .collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_snapshot() -> Qu16MeterEnvelope {
        recorded_snapshot(9, 3, 1, 1_000, 4_920, 1, -11.0)
    }

    #[test]
    fn native_desktop_snapshot_deserializes_without_bridge_fields() {
        let json = r#"{
            "source":"qu16-tcp-midi",
            "sessionId":9,
            "connected":true,
            "state":"metering",
            "updatedAtMs":1000,
            "frameSequence":1,
            "host":"192.0.2.10",
            "channels":{"ch-1":{"levelDbfs":-12.0,"peakDbfs":-11.0}},
            "masters":{},
            "monitor":{},
            "rtaDbfs":[]
        }"#;
        let snapshot: Qu16TcpMeterSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snapshot.session_id, 9);
        assert_eq!(snapshot.channels["ch-1"].peak_dbfs, -11.0);
    }

    #[test]
    fn wrong_generation_is_rejected() {
        let mut adapter = Qu16ReturnMeterAdapter::new(9, 4, 250);
        assert!(matches!(
            adapter.ingest(&valid_snapshot(), 1_000),
            Err(Qu16MeterRejection::WrongGeneration)
        ));
    }

    #[test]
    fn stale_snapshot_is_rejected() {
        let mut adapter = Qu16ReturnMeterAdapter::new(9, 3, 250);
        assert!(matches!(
            adapter.ingest(&valid_snapshot(), 1_251),
            Err(Qu16MeterRejection::Stale)
        ));
    }

    #[test]
    fn disconnect_invalidates_future_snapshots() {
        let mut adapter = Qu16ReturnMeterAdapter::new(9, 3, 250);
        adapter.disconnect();
        assert!(matches!(
            adapter.ingest(&valid_snapshot(), 1_000),
            Err(Qu16MeterRejection::Disconnected)
        ));
    }

    #[test]
    fn sequence_must_increase() {
        let mut adapter = Qu16ReturnMeterAdapter::new(9, 3, 250);
        let snapshot = valid_snapshot();
        assert!(adapter.ingest(&snapshot, 1_000).is_ok());
        assert!(matches!(
            adapter.ingest(&snapshot, 1_000),
            Err(Qu16MeterRejection::NonMonotonicSequence)
        ));
    }

    #[test]
    fn invalid_peak_is_rejected() {
        let mut adapter = Qu16ReturnMeterAdapter::new(9, 3, 250);
        let mut snapshot = valid_snapshot();
        snapshot
            .snapshot
            .channels
            .get_mut("ch-1")
            .unwrap()
            .peak_dbfs = f32::NAN;
        assert!(matches!(
            adapter.ingest(&snapshot, 1_000),
            Err(Qu16MeterRejection::InvalidPeak)
        ));
    }

    #[test]
    fn recorded_adapter_replay_completes_joint_evidence() {
        let report = run_default_qu16_meter_adapter_replay().unwrap();
        assert_eq!(report.recorded_snapshots, 5);
        assert_eq!(report.adapter.accepted, 3);
        assert_eq!(report.adapter.rejected, 2);
        assert_eq!(report.adapter.wrong_generation, 1);
        assert_eq!(report.adapter.stale, 1);
        assert!(report.joint_evidence.all_lanes_synchronized);
        assert_eq!(report.joint_evidence.maximum_observed_skew_frames, 120);
        assert!(!report.output_stream_started);
        assert!(!report.qu16_writes_performed);
        assert!(!report.hardware_ready);
    }
}
