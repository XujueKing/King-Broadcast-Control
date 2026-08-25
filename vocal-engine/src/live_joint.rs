use crate::{
    capture::{MeterFrame, MeterReplayFixture},
    joint::{run_joint_replay, JointCalibrationReport},
    routing::{AsioChannelDescriptor, AsioChannelInventory, AsioDirection},
    EngineError, SAMPLE_RATE,
};
use serde::Serialize;
use std::collections::VecDeque;

const LIVE_JOINT_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_SKEW_FRAMES: u64 = 960;
const DEFAULT_TIMEOUT_MS: u64 = 250;
const MAX_QUEUE_DEPTH: usize = 32;
const FRAMES_PER_MILLISECOND: u64 = 48;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveJointRejection {
    WrongDirection,
    StaleInput,
    StaleReturn,
    DriftedInput,
    DriftedReturn,
    QueueOverflow,
    ReturnDisconnected,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveJointPair {
    pub return_generation: u64,
    pub input: MeterFrame,
    pub returned: MeterFrame,
    pub skew_frames: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveJointMatcherStatus {
    pub schema_version: u32,
    pub mode: &'static str,
    pub return_generation: Option<u64>,
    pub input_queue_depth: usize,
    pub return_queue_depth: usize,
    pub matched_pairs: usize,
    pub rejected_frames: usize,
    pub timeout_rejections: usize,
    pub drift_rejections: usize,
    pub generation_resets: usize,
    pub disconnects: usize,
    pub maximum_observed_skew_frames: u64,
    pub maximum_allowed_skew_frames: u64,
    pub last_rejection: Option<LiveJointRejection>,
    pub evidence_live: bool,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub hardware_ready: bool,
}

#[derive(Clone)]
struct QueuedFrame {
    arrival_ms: u64,
    frame: MeterFrame,
}

pub struct LiveJointEvidenceMatcher {
    inputs: VecDeque<QueuedFrame>,
    returns: VecDeque<QueuedFrame>,
    status: LiveJointMatcherStatus,
    timeout_ms: u64,
    max_skew_frames: u64,
}

impl Default for LiveJointEvidenceMatcher {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_SKEW_FRAMES, DEFAULT_TIMEOUT_MS)
    }
}

impl LiveJointEvidenceMatcher {
    pub fn new(max_skew_frames: u64, timeout_ms: u64) -> Self {
        Self {
            inputs: VecDeque::new(),
            returns: VecDeque::new(),
            status: LiveJointMatcherStatus {
                schema_version: LIVE_JOINT_SCHEMA_VERSION,
                mode: "live_usb_qu16_evidence_matcher",
                return_generation: None,
                input_queue_depth: 0,
                return_queue_depth: 0,
                matched_pairs: 0,
                rejected_frames: 0,
                timeout_rejections: 0,
                drift_rejections: 0,
                generation_resets: 0,
                disconnects: 0,
                maximum_observed_skew_frames: 0,
                maximum_allowed_skew_frames: max_skew_frames,
                last_rejection: None,
                evidence_live: false,
                output_stream_started: false,
                qu16_writes_performed: false,
                hardware_ready: false,
            },
            timeout_ms,
            max_skew_frames,
        }
    }

    pub fn status(&self) -> LiveJointMatcherStatus {
        self.status.clone()
    }

    pub fn ingest_input(
        &mut self,
        frame: MeterFrame,
        arrival_ms: u64,
        now_ms: u64,
    ) -> Result<Vec<LiveJointPair>, EngineError> {
        if frame.direction != AsioDirection::Input {
            self.reject(LiveJointRejection::WrongDirection);
            return Err(EngineError("live joint input direction mismatch".into()));
        }
        if now_ms.saturating_sub(arrival_ms) > self.timeout_ms {
            self.reject_timeout(LiveJointRejection::StaleInput);
            return Ok(Vec::new());
        }
        self.push_input(QueuedFrame { arrival_ms, frame });
        Ok(self.match_ready())
    }

    pub fn ingest_return(
        &mut self,
        generation: u64,
        frame: MeterFrame,
        arrival_ms: u64,
        now_ms: u64,
    ) -> Result<Vec<LiveJointPair>, EngineError> {
        if frame.direction != AsioDirection::Output {
            self.reject(LiveJointRejection::WrongDirection);
            return Err(EngineError("live joint return direction mismatch".into()));
        }
        if self.status.return_generation != Some(generation) {
            if self.status.return_generation.is_some() {
                self.status.generation_resets += 1;
                self.inputs.clear();
                self.returns.clear();
                self.status.evidence_live = false;
            }
            self.status.return_generation = Some(generation);
        }
        if now_ms.saturating_sub(arrival_ms) > self.timeout_ms {
            self.reject_timeout(LiveJointRejection::StaleReturn);
            return Ok(Vec::new());
        }
        self.push_return(QueuedFrame { arrival_ms, frame });
        Ok(self.match_ready())
    }

    pub fn tick(&mut self, now_ms: u64) {
        while self
            .inputs
            .front()
            .is_some_and(|queued| now_ms.saturating_sub(queued.arrival_ms) > self.timeout_ms)
        {
            self.inputs.pop_front();
            self.reject_timeout(LiveJointRejection::StaleInput);
        }
        while self
            .returns
            .front()
            .is_some_and(|queued| now_ms.saturating_sub(queued.arrival_ms) > self.timeout_ms)
        {
            self.returns.pop_front();
            self.reject_timeout(LiveJointRejection::StaleReturn);
        }
        if self.inputs.is_empty() || self.returns.is_empty() {
            self.status.evidence_live = false;
        }
        self.update_depths();
    }

    pub fn disconnect_return(&mut self) {
        self.inputs.clear();
        self.returns.clear();
        self.status.disconnects += 1;
        self.status.return_generation = None;
        self.status.evidence_live = false;
        self.reject(LiveJointRejection::ReturnDisconnected);
        self.update_depths();
    }

    fn push_input(&mut self, queued: QueuedFrame) {
        if self.inputs.len() == MAX_QUEUE_DEPTH {
            self.inputs.pop_front();
            self.reject(LiveJointRejection::QueueOverflow);
        }
        self.inputs.push_back(queued);
        self.update_depths();
    }

    fn push_return(&mut self, queued: QueuedFrame) {
        if self.returns.len() == MAX_QUEUE_DEPTH {
            self.returns.pop_front();
            self.reject(LiveJointRejection::QueueOverflow);
        }
        self.returns.push_back(queued);
        self.update_depths();
    }

    fn match_ready(&mut self) -> Vec<LiveJointPair> {
        let mut pairs = Vec::new();
        while let (Some(input), Some(returned)) = (self.inputs.front(), self.returns.front()) {
            let skew = input
                .frame
                .frame_position
                .abs_diff(returned.frame.frame_position);
            if skew <= self.max_skew_frames {
                let input = self.inputs.pop_front().expect("front exists").frame;
                let returned = self.returns.pop_front().expect("front exists").frame;
                self.status.matched_pairs += 1;
                self.status.maximum_observed_skew_frames =
                    self.status.maximum_observed_skew_frames.max(skew);
                self.status.last_rejection = None;
                self.status.evidence_live = true;
                pairs.push(LiveJointPair {
                    return_generation: self.status.return_generation.unwrap_or(0),
                    input,
                    returned,
                    skew_frames: skew,
                });
            } else if input.frame.frame_position < returned.frame.frame_position {
                self.inputs.pop_front();
                self.reject_drift(LiveJointRejection::DriftedInput);
            } else {
                self.returns.pop_front();
                self.reject_drift(LiveJointRejection::DriftedReturn);
            }
        }
        self.update_depths();
        pairs
    }

    fn reject(&mut self, rejection: LiveJointRejection) {
        self.status.rejected_frames += 1;
        self.status.last_rejection = Some(rejection);
        self.status.evidence_live = false;
    }

    fn reject_timeout(&mut self, rejection: LiveJointRejection) {
        self.status.timeout_rejections += 1;
        self.reject(rejection);
    }

    fn reject_drift(&mut self, rejection: LiveJointRejection) {
        self.status.drift_rejections += 1;
        self.reject(rejection);
    }

    fn update_depths(&mut self) {
        self.status.input_queue_depth = self.inputs.len();
        self.status.return_queue_depth = self.returns.len();
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usb48kClockAnchor {
    pub epoch_frame_position: u64,
    pub local_frame_position: u64,
}

impl Usb48kClockAnchor {
    pub fn from_unix_ms(unix_ms: u64, local_frame_position: u64) -> Self {
        Self {
            epoch_frame_position: unix_ms.saturating_mul(FRAMES_PER_MILLISECOND),
            local_frame_position,
        }
    }

    pub fn map(&self, local_frame_position: u64) -> u64 {
        if local_frame_position >= self.local_frame_position {
            self.epoch_frame_position
                .saturating_add(local_frame_position - self.local_frame_position)
        } else {
            self.epoch_frame_position
                .saturating_sub(self.local_frame_position - local_frame_position)
        }
    }

    pub fn map_frame(&self, mut frame: MeterFrame) -> Result<MeterFrame, EngineError> {
        if frame.direction != AsioDirection::Input {
            return Err(EngineError(
                "USB clock anchor accepts input frames only".into(),
            ));
        }
        frame.frame_position = self.map(frame.frame_position);
        Ok(frame)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveJointReplayReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub clock_anchor: Usb48kClockAnchor,
    pub matcher: LiveJointMatcherStatus,
    pub pairs: Vec<LiveJointPair>,
    pub calibration: JointCalibrationReport,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub hardware_ready: bool,
}

pub fn run_default_live_joint_replay() -> Result<LiveJointReplayReport, EngineError> {
    let epoch_ms = 1_000_000;
    let anchor = Usb48kClockAnchor::from_unix_ms(epoch_ms, 0);
    let mut matcher = LiveJointEvidenceMatcher::default();
    let mut pairs = Vec::new();

    for (sequence, local_position, input_channel, return_position, return_channel) in [
        (1, 0, 2, 48_000_096, 1),
        (2, 4_800, 5, 48_004_848, 4),
        (3, 9_600, 9, 48_009_720, 8),
    ] {
        let input = anchor.map_frame(frame(
            sequence,
            local_position,
            AsioDirection::Input,
            input_channel,
            -12.0,
        ))?;
        if sequence == 1 {
            let drifted = frame(99, 47_997_000, AsioDirection::Output, 16, -81.0);
            pairs.extend(matcher.ingest_return(1, drifted, epoch_ms, epoch_ms)?);
        }
        pairs.extend(matcher.ingest_input(input, epoch_ms, epoch_ms)?);
        pairs.extend(matcher.ingest_return(
            1,
            frame(
                sequence,
                return_position,
                AsioDirection::Output,
                return_channel,
                -11.0,
            ),
            epoch_ms,
            epoch_ms,
        )?);
    }

    matcher.ingest_input(
        anchor.map_frame(frame(10, 14_400, AsioDirection::Input, 2, -20.0))?,
        epoch_ms,
        epoch_ms,
    )?;
    matcher.tick(epoch_ms + DEFAULT_TIMEOUT_MS + 1);
    matcher.disconnect_return();

    let input_fixture = MeterReplayFixture {
        schema_version: 1,
        name: "p24_shared_clock_usb_input".into(),
        inventory: AsioChannelInventory {
            driver_name: "P24 Recorded USB Input".into(),
            sample_rate: SAMPLE_RATE,
            physical_hardware: false,
            input_channels: [(2, "USB Mic A"), (5, "USB Mic B"), (9, "USB Mic C")]
                .into_iter()
                .map(|(driver_index, name)| descriptor(driver_index, name, AsioDirection::Input))
                .collect(),
            output_channels: Vec::new(),
        },
        frames: pairs.iter().map(|pair| pair.input.clone()).collect(),
        physical_capture: false,
    };
    let return_fixture = MeterReplayFixture {
        schema_version: 1,
        name: "p24_shared_clock_qu16_return".into(),
        inventory: AsioChannelInventory {
            driver_name: "P24 Recorded Qu-16 Return".into(),
            sample_rate: SAMPLE_RATE,
            physical_hardware: false,
            input_channels: Vec::new(),
            output_channels: [
                (1, "Qu-16 Return A"),
                (4, "Qu-16 Return B"),
                (8, "Qu-16 Return C"),
            ]
            .into_iter()
            .map(|(driver_index, name)| descriptor(driver_index, name, AsioDirection::Output))
            .collect(),
        },
        frames: pairs.iter().map(|pair| pair.returned.clone()).collect(),
        physical_capture: false,
    };
    let calibration = run_joint_replay(input_fixture, return_fixture)?;
    Ok(LiveJointReplayReport {
        schema_version: LIVE_JOINT_SCHEMA_VERSION,
        mode: "recorded_live_usb_qu16_shared_clock_replay",
        clock_anchor: anchor,
        matcher: matcher.status(),
        pairs,
        calibration,
        output_stream_started: false,
        qu16_writes_performed: false,
        hardware_ready: false,
    })
}

fn frame(
    sequence: u64,
    frame_position: u64,
    direction: AsioDirection,
    driver_index: usize,
    peak_dbfs: f32,
) -> MeterFrame {
    MeterFrame {
        sequence,
        frame_position,
        direction,
        peaks: vec![crate::capture::ChannelPeak {
            driver_index,
            peak_dbfs,
        }],
    }
}

fn descriptor(driver_index: usize, name: &str, direction: AsioDirection) -> AsioChannelDescriptor {
    AsioChannelDescriptor {
        driver_index,
        name: name.into(),
        direction,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usb_anchor_maps_local_frames_to_shared_epoch() {
        let anchor = Usb48kClockAnchor::from_unix_ms(1_000, 128);
        assert_eq!(anchor.map(128), 48_000);
        assert_eq!(anchor.map(608), 48_480);
    }

    #[test]
    fn matcher_pairs_only_frames_inside_drift_limit() {
        let mut matcher = LiveJointEvidenceMatcher::default();
        matcher
            .ingest_return(1, frame(1, 7_000, AsioDirection::Output, 1, -11.0), 0, 0)
            .unwrap();
        let pairs = matcher
            .ingest_input(frame(1, 10_000, AsioDirection::Input, 2, -12.0), 0, 0)
            .unwrap();
        assert!(pairs.is_empty());
        assert_eq!(matcher.status().drift_rejections, 1);
        let pairs = matcher
            .ingest_return(1, frame(2, 10_120, AsioDirection::Output, 1, -11.0), 0, 0)
            .unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].skew_frames, 120);
    }

    #[test]
    fn timeout_and_disconnect_clear_pending_evidence() {
        let mut matcher = LiveJointEvidenceMatcher::default();
        matcher
            .ingest_input(frame(1, 10_000, AsioDirection::Input, 2, -12.0), 0, 0)
            .unwrap();
        matcher.tick(251);
        assert_eq!(matcher.status().timeout_rejections, 1);
        matcher.disconnect_return();
        assert_eq!(matcher.status().disconnects, 1);
        assert!(!matcher.status().evidence_live);
        assert_eq!(matcher.status().input_queue_depth, 0);
    }

    #[test]
    fn generation_change_cannot_pair_with_old_input() {
        let mut matcher = LiveJointEvidenceMatcher::default();
        matcher
            .ingest_return(1, frame(1, 10_000, AsioDirection::Output, 1, -11.0), 0, 0)
            .unwrap();
        matcher
            .ingest_input(frame(1, 20_000, AsioDirection::Input, 2, -12.0), 0, 0)
            .unwrap();
        let pairs = matcher
            .ingest_return(2, frame(1, 20_100, AsioDirection::Output, 1, -11.0), 0, 0)
            .unwrap();
        assert!(pairs.is_empty());
        assert_eq!(matcher.status().generation_resets, 1);
        assert_eq!(matcher.status().input_queue_depth, 0);
    }

    #[test]
    fn default_replay_drives_existing_joint_calibration_without_hardware_claim() {
        let report = run_default_live_joint_replay().unwrap();
        assert_eq!(report.pairs.len(), 3);
        assert_eq!(report.matcher.drift_rejections, 1);
        assert_eq!(report.matcher.timeout_rejections, 1);
        assert_eq!(report.matcher.disconnects, 1);
        assert!(report.calibration.all_lanes_synchronized);
        assert!(!report.output_stream_started);
        assert!(!report.qu16_writes_performed);
        assert!(!report.hardware_ready);
    }
}
