use crate::{
    capture::MeterFrame,
    clock_drift::{
        ClockDriftRejection, ClockDriftState, DriftAwareJointPair, DriftAwareLiveJointMatcher,
    },
    EngineError,
};
use serde::Serialize;
use std::sync::{Arc, RwLock};

const RUNTIME_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DriftRuntimeState {
    #[default]
    Disconnected,
    Acquiring,
    Locked,
    Unsafe,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DriftRuntimeFault {
    ReturnDisconnected,
    BaseOffsetOutOfRange,
    DriftRateOutOfRange,
    ResidualOutlier,
    NonMonotonicInputClock,
    WrongDirection,
    MatcherRejectedEvidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftRuntimeTelemetrySnapshot {
    pub schema_version: u32,
    pub mode: &'static str,
    pub state: DriftRuntimeState,
    pub revision: u64,
    pub connection_generation: Option<u64>,
    pub generations_seen: u64,
    pub lock_acquisitions: u64,
    pub disconnects: u64,
    pub matched_pairs: u64,
    pub accepted_observations: usize,
    pub rejected_observations: usize,
    pub estimated_drift_ppm: f64,
    pub latest_residual_frames: Option<f64>,
    pub evidence_live: bool,
    pub last_fault: Option<DriftRuntimeFault>,
    pub bounded_snapshot: bool,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub audio_resampling_performed: bool,
    pub hardware_ready: bool,
}

impl Default for DriftRuntimeTelemetrySnapshot {
    fn default() -> Self {
        Self {
            schema_version: RUNTIME_SCHEMA_VERSION,
            mode: "long_running_clock_drift_controller",
            state: DriftRuntimeState::Disconnected,
            revision: 0,
            connection_generation: None,
            generations_seen: 0,
            lock_acquisitions: 0,
            disconnects: 0,
            matched_pairs: 0,
            accepted_observations: 0,
            rejected_observations: 0,
            estimated_drift_ppm: 0.0,
            latest_residual_frames: None,
            evidence_live: false,
            last_fault: None,
            bounded_snapshot: true,
            output_stream_started: false,
            qu16_writes_performed: false,
            audio_resampling_performed: false,
            hardware_ready: false,
        }
    }
}

struct DriftRuntimeTelemetryShared {
    snapshot: RwLock<DriftRuntimeTelemetrySnapshot>,
}

#[derive(Clone)]
pub struct DriftRuntimeTelemetryPublisher(Arc<DriftRuntimeTelemetryShared>);

#[derive(Clone)]
pub struct DriftRuntimeTelemetryReceiver(Arc<DriftRuntimeTelemetryShared>);

pub fn drift_runtime_telemetry_channel() -> (
    DriftRuntimeTelemetryPublisher,
    DriftRuntimeTelemetryReceiver,
) {
    let shared = Arc::new(DriftRuntimeTelemetryShared {
        snapshot: RwLock::new(DriftRuntimeTelemetrySnapshot::default()),
    });
    (
        DriftRuntimeTelemetryPublisher(Arc::clone(&shared)),
        DriftRuntimeTelemetryReceiver(shared),
    )
}

impl DriftRuntimeTelemetryPublisher {
    fn publish(&self, mut snapshot: DriftRuntimeTelemetrySnapshot) {
        let mut current = self
            .0
            .snapshot
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        snapshot.revision = current.revision.saturating_add(1);
        *current = snapshot;
    }
}

impl DriftRuntimeTelemetryReceiver {
    pub fn snapshot(&self) -> DriftRuntimeTelemetrySnapshot {
        self.0
            .snapshot
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

pub struct DriftRuntimeController {
    matcher: DriftAwareLiveJointMatcher,
    telemetry: DriftRuntimeTelemetryPublisher,
    generation: Option<u64>,
    generations_seen: u64,
    lock_acquisitions: u64,
    disconnects: u64,
    matched_pairs: u64,
    last_state: DriftRuntimeState,
    last_fault: Option<DriftRuntimeFault>,
}

impl DriftRuntimeController {
    pub fn new(telemetry: DriftRuntimeTelemetryPublisher) -> Self {
        let mut controller = Self {
            matcher: DriftAwareLiveJointMatcher::default(),
            telemetry,
            generation: None,
            generations_seen: 0,
            lock_acquisitions: 0,
            disconnects: 0,
            matched_pairs: 0,
            last_state: DriftRuntimeState::Disconnected,
            last_fault: None,
        };
        controller.publish();
        controller
    }

    pub fn ingest_input(
        &mut self,
        frame: MeterFrame,
        arrival_ms: u64,
        now_ms: u64,
    ) -> Result<Vec<DriftAwareJointPair>, EngineError> {
        let result = self.matcher.ingest_input(frame, arrival_ms, now_ms);
        self.finish(result)
    }

    pub fn ingest_return(
        &mut self,
        generation: u64,
        frame: MeterFrame,
        arrival_ms: u64,
        now_ms: u64,
    ) -> Result<Vec<DriftAwareJointPair>, EngineError> {
        if self.generation != Some(generation) {
            self.generation = Some(generation);
            self.generations_seen = self.generations_seen.saturating_add(1);
            self.last_fault = None;
        }
        let result = self
            .matcher
            .ingest_return(generation, frame, arrival_ms, now_ms);
        self.finish(result)
    }

    pub fn disconnect_return(&mut self) {
        self.matcher.disconnect_return();
        self.generation = None;
        self.disconnects = self.disconnects.saturating_add(1);
        self.last_fault = Some(DriftRuntimeFault::ReturnDisconnected);
        self.publish();
    }

    pub fn snapshot(&self) -> DriftRuntimeTelemetrySnapshot {
        self.build_snapshot()
    }

    fn finish(
        &mut self,
        result: Result<Vec<DriftAwareJointPair>, EngineError>,
    ) -> Result<Vec<DriftAwareJointPair>, EngineError> {
        match result {
            Ok(pairs) => {
                self.matched_pairs = self.matched_pairs.saturating_add(pairs.len() as u64);
                self.publish();
                Ok(pairs)
            }
            Err(error) => {
                let estimator = self.matcher.status().estimator;
                self.last_fault = estimator
                    .last_rejection
                    .map(map_drift_fault)
                    .or(Some(DriftRuntimeFault::MatcherRejectedEvidence));
                self.publish();
                Err(error)
            }
        }
    }

    fn publish(&mut self) {
        let snapshot = self.build_snapshot();
        if snapshot.state == DriftRuntimeState::Locked
            && self.last_state != DriftRuntimeState::Locked
        {
            self.lock_acquisitions = self.lock_acquisitions.saturating_add(1);
        }
        self.last_state = snapshot.state;
        self.telemetry.publish(self.build_snapshot());
    }

    fn build_snapshot(&self) -> DriftRuntimeTelemetrySnapshot {
        let status = self.matcher.status();
        let state = if status.estimator.state == ClockDriftState::Unsafe {
            DriftRuntimeState::Unsafe
        } else if self.generation.is_none() || status.matcher.return_generation.is_none() {
            DriftRuntimeState::Disconnected
        } else if status.estimator.state == ClockDriftState::Locked {
            DriftRuntimeState::Locked
        } else {
            DriftRuntimeState::Acquiring
        };
        DriftRuntimeTelemetrySnapshot {
            state,
            connection_generation: self.generation,
            generations_seen: self.generations_seen,
            lock_acquisitions: self.lock_acquisitions,
            disconnects: self.disconnects,
            matched_pairs: self.matched_pairs,
            accepted_observations: status.estimator.accepted_observations,
            rejected_observations: status.estimator.rejected_observations,
            estimated_drift_ppm: status.estimator.estimated_drift_ppm,
            latest_residual_frames: status.estimator.latest_residual_frames,
            evidence_live: state == DriftRuntimeState::Locked && status.matcher.evidence_live,
            last_fault: self.last_fault,
            ..DriftRuntimeTelemetrySnapshot::default()
        }
    }
}

fn map_drift_fault(rejection: ClockDriftRejection) -> DriftRuntimeFault {
    match rejection {
        ClockDriftRejection::BaseOffsetOutOfRange => DriftRuntimeFault::BaseOffsetOutOfRange,
        ClockDriftRejection::DriftRateOutOfRange => DriftRuntimeFault::DriftRateOutOfRange,
        ClockDriftRejection::ResidualOutlier => DriftRuntimeFault::ResidualOutlier,
        ClockDriftRejection::NonMonotonicInputClock => DriftRuntimeFault::NonMonotonicInputClock,
        ClockDriftRejection::WrongDirection => DriftRuntimeFault::WrongDirection,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftRuntimeReplayReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub states: Vec<DriftRuntimeTelemetrySnapshot>,
    pub final_status: DriftRuntimeTelemetrySnapshot,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub audio_resampling_performed: bool,
    pub hardware_ready: bool,
}

pub fn run_default_drift_runtime_replay() -> Result<DriftRuntimeReplayReport, EngineError> {
    let (publisher, receiver) = drift_runtime_telemetry_channel();
    let mut controller = DriftRuntimeController::new(publisher);
    let mut states = vec![receiver.snapshot()];

    feed_generation(&mut controller, 1, 100_000_000, 120.0, 75.0, 6)?;
    states.push(receiver.snapshot());

    controller.disconnect_return();
    states.push(receiver.snapshot());

    feed_generation(&mut controller, 2, 200_000_000, 80.0, 40.0, 6)?;
    states.push(receiver.snapshot());

    let unsafe_input = 200_000_000 + 6 * 480_000;
    controller.ingest_input(
        runtime_frame(7, unsafe_input, crate::routing::AsioDirection::Input),
        60_000,
        60_000,
    )?;
    let _expected_failure = controller
        .ingest_return(
            2,
            runtime_frame(
                7,
                unsafe_input + 1_000,
                crate::routing::AsioDirection::Output,
            ),
            60_000,
            60_000,
        )
        .expect_err("excessive drift must fail closed");
    states.push(receiver.snapshot());

    Ok(DriftRuntimeReplayReport {
        schema_version: RUNTIME_SCHEMA_VERSION,
        mode: "reconnect_relock_and_unsafe_replay",
        final_status: receiver.snapshot(),
        states,
        output_stream_started: false,
        qu16_writes_performed: false,
        audio_resampling_performed: false,
        hardware_ready: false,
    })
}

fn feed_generation(
    controller: &mut DriftRuntimeController,
    generation: u64,
    base: u64,
    base_offset: f64,
    drift_ppm: f64,
    observations: u64,
) -> Result<(), EngineError> {
    for index in 0..observations {
        let elapsed = index * 480_000;
        let input_position = base + elapsed;
        let offset = base_offset + elapsed as f64 * drift_ppm / 1_000_000.0;
        let now_ms = index * 10_000;
        controller.ingest_input(
            runtime_frame(
                index + 1,
                input_position,
                crate::routing::AsioDirection::Input,
            ),
            now_ms,
            now_ms,
        )?;
        controller.ingest_return(
            generation,
            runtime_frame(
                index + 1,
                input_position + offset.round() as u64,
                crate::routing::AsioDirection::Output,
            ),
            now_ms,
            now_ms,
        )?;
    }
    Ok(())
}

fn runtime_frame(
    sequence: u64,
    frame_position: u64,
    direction: crate::routing::AsioDirection,
) -> MeterFrame {
    MeterFrame {
        sequence,
        frame_position,
        direction,
        peaks: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::AsioDirection;

    #[test]
    fn telemetry_snapshot_is_fixed_size_and_revisioned() {
        let (publisher, receiver) = drift_runtime_telemetry_channel();
        let mut controller = DriftRuntimeController::new(publisher);
        let initial = receiver.snapshot();
        controller
            .ingest_input(runtime_frame(1, 10_000, AsioDirection::Input), 0, 0)
            .unwrap();
        let next = receiver.snapshot();
        assert!(next.revision > initial.revision);
        assert!(next.bounded_snapshot);
        assert_eq!(
            std::mem::size_of_val(&initial),
            std::mem::size_of_val(&next)
        );
    }

    #[test]
    fn reconnect_requires_a_fresh_lock() {
        let (publisher, receiver) = drift_runtime_telemetry_channel();
        let mut controller = DriftRuntimeController::new(publisher);
        feed_generation(&mut controller, 1, 1_000_000, 120.0, 50.0, 6).unwrap();
        assert_eq!(receiver.snapshot().state, DriftRuntimeState::Locked);
        controller.disconnect_return();
        assert_eq!(receiver.snapshot().state, DriftRuntimeState::Disconnected);
        feed_generation(&mut controller, 2, 10_000_000, 80.0, 30.0, 1).unwrap();
        let acquiring = receiver.snapshot();
        assert_eq!(acquiring.state, DriftRuntimeState::Acquiring);
        assert!(!acquiring.evidence_live);
        feed_generation(&mut controller, 2, 10_480_000, 94.0, 30.0, 5).unwrap();
        let relocked = receiver.snapshot();
        assert_eq!(relocked.state, DriftRuntimeState::Locked);
        assert_eq!(relocked.lock_acquisitions, 2);
    }

    #[test]
    fn disconnect_publishes_reason_and_clears_live_evidence() {
        let (publisher, receiver) = drift_runtime_telemetry_channel();
        let mut controller = DriftRuntimeController::new(publisher);
        feed_generation(&mut controller, 4, 1_000_000, 100.0, 25.0, 6).unwrap();
        controller.disconnect_return();
        let snapshot = receiver.snapshot();
        assert_eq!(snapshot.state, DriftRuntimeState::Disconnected);
        assert_eq!(
            snapshot.last_fault,
            Some(DriftRuntimeFault::ReturnDisconnected)
        );
        assert!(!snapshot.evidence_live);
    }

    #[test]
    fn unsafe_drift_is_published_and_fails_closed() {
        let report = run_default_drift_runtime_replay().unwrap();
        assert_eq!(report.states[1].state, DriftRuntimeState::Locked);
        assert_eq!(report.states[2].state, DriftRuntimeState::Disconnected);
        assert_eq!(report.states[3].state, DriftRuntimeState::Locked);
        assert_eq!(report.final_status.state, DriftRuntimeState::Unsafe);
        assert_eq!(
            report.final_status.last_fault,
            Some(DriftRuntimeFault::DriftRateOutOfRange)
        );
        assert_eq!(report.final_status.lock_acquisitions, 2);
        assert!(!report.hardware_ready);
    }
}
