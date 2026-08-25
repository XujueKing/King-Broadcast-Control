use crate::{
    capture::MeterFrame,
    live_joint::{LiveJointEvidenceMatcher, LiveJointMatcherStatus, LiveJointPair},
    routing::AsioDirection,
    EngineError, SAMPLE_RATE,
};
use serde::Serialize;
use std::collections::BTreeMap;

const DRIFT_SCHEMA_VERSION: u32 = 1;
const MAX_BASE_OFFSET_FRAMES: i64 = 2_400;
const MAX_DRIFT_PPM: f64 = 200.0;
const MAX_RESIDUAL_FRAMES: f64 = 240.0;
const LOCK_OBSERVATIONS: usize = 5;
const MAX_CONSECUTIVE_OUTLIERS: usize = 3;
const DRIFT_SMOOTHING: f64 = 0.25;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockDriftState {
    Uninitialized,
    Acquiring,
    Locked,
    Unsafe,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockDriftRejection {
    BaseOffsetOutOfRange,
    DriftRateOutOfRange,
    ResidualOutlier,
    NonMonotonicInputClock,
    WrongDirection,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockDriftStatus {
    pub schema_version: u32,
    pub mode: &'static str,
    pub state: ClockDriftState,
    pub accepted_observations: usize,
    pub rejected_observations: usize,
    pub consecutive_outliers: usize,
    pub base_offset_frames: Option<i64>,
    pub estimated_drift_ppm: f64,
    pub latest_residual_frames: Option<f64>,
    pub maximum_residual_frames: f64,
    pub last_rejection: Option<ClockDriftRejection>,
    pub timestamp_correction_only: bool,
    pub audio_resampling_performed: bool,
    pub hardware_ready: bool,
}

pub struct ClockDriftEstimator {
    status: ClockDriftStatus,
    reference_input_position: Option<u64>,
    last_input_position: Option<u64>,
}

impl Default for ClockDriftEstimator {
    fn default() -> Self {
        Self {
            status: ClockDriftStatus {
                schema_version: DRIFT_SCHEMA_VERSION,
                mode: "usb_qu16_timestamp_drift_estimator",
                state: ClockDriftState::Uninitialized,
                accepted_observations: 0,
                rejected_observations: 0,
                consecutive_outliers: 0,
                base_offset_frames: None,
                estimated_drift_ppm: 0.0,
                latest_residual_frames: None,
                maximum_residual_frames: 0.0,
                last_rejection: None,
                timestamp_correction_only: true,
                audio_resampling_performed: false,
                hardware_ready: false,
            },
            reference_input_position: None,
            last_input_position: None,
        }
    }
}

impl ClockDriftEstimator {
    pub fn status(&self) -> ClockDriftStatus {
        self.status.clone()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn observe(
        &mut self,
        input_position: u64,
        return_position: u64,
    ) -> Result<(), ClockDriftRejection> {
        if self.status.state == ClockDriftState::Unsafe {
            return Err(self
                .status
                .last_rejection
                .unwrap_or(ClockDriftRejection::ResidualOutlier));
        }
        if self
            .last_input_position
            .is_some_and(|previous| input_position <= previous)
        {
            return self.reject(ClockDriftRejection::NonMonotonicInputClock, true);
        }
        let observed_offset = signed_difference(return_position, input_position);
        if self.status.state == ClockDriftState::Uninitialized {
            if observed_offset.unsigned_abs() > MAX_BASE_OFFSET_FRAMES as u64 {
                return self.reject(ClockDriftRejection::BaseOffsetOutOfRange, true);
            }
            self.status.state = ClockDriftState::Acquiring;
            self.status.base_offset_frames = Some(observed_offset);
            self.status.accepted_observations = 1;
            self.status.last_rejection = None;
            self.reference_input_position = Some(input_position);
            self.last_input_position = Some(input_position);
            return Ok(());
        }

        let reference = self.reference_input_position.expect("initialized above");
        let elapsed_frames = input_position - reference;
        if elapsed_frames == 0 {
            return self.reject(ClockDriftRejection::NonMonotonicInputClock, true);
        }
        let base = self.status.base_offset_frames.unwrap_or(0) as f64;
        let observed_rate_ppm =
            (observed_offset as f64 - base) * 1_000_000.0 / elapsed_frames as f64;
        if !observed_rate_ppm.is_finite() || observed_rate_ppm.abs() > MAX_DRIFT_PPM {
            return self.reject(ClockDriftRejection::DriftRateOutOfRange, true);
        }
        let predicted =
            base + self.status.estimated_drift_ppm * elapsed_frames as f64 / 1_000_000.0;
        let residual = observed_offset as f64 - predicted;
        self.status.latest_residual_frames = Some(residual);
        self.status.maximum_residual_frames =
            self.status.maximum_residual_frames.max(residual.abs());
        if residual.abs() > MAX_RESIDUAL_FRAMES {
            return self.reject(ClockDriftRejection::ResidualOutlier, false);
        }

        self.status.estimated_drift_ppm +=
            (observed_rate_ppm - self.status.estimated_drift_ppm) * DRIFT_SMOOTHING;
        self.status.accepted_observations += 1;
        self.status.consecutive_outliers = 0;
        self.status.last_rejection = None;
        self.last_input_position = Some(input_position);
        if self.status.accepted_observations >= LOCK_OBSERVATIONS {
            self.status.state = ClockDriftState::Locked;
        }
        Ok(())
    }

    pub fn correction_at(&self, approximate_input_position: u64) -> i64 {
        let Some(reference) = self.reference_input_position else {
            return 0;
        };
        let base = self.status.base_offset_frames.unwrap_or(0) as f64;
        let elapsed = approximate_input_position.saturating_sub(reference) as f64;
        let correction = base + self.status.estimated_drift_ppm * elapsed / 1_000_000.0;
        correction.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64
    }

    pub fn correct_return_frame(&self, mut frame: MeterFrame) -> Result<MeterFrame, EngineError> {
        if frame.direction != AsioDirection::Output {
            return Err(EngineError(
                "clock drift correction accepts return frames only".into(),
            ));
        }
        let correction = self.correction_at(frame.frame_position);
        frame.frame_position = apply_signed_correction(frame.frame_position, correction);
        Ok(frame)
    }

    fn reject(
        &mut self,
        rejection: ClockDriftRejection,
        immediate_unsafe: bool,
    ) -> Result<(), ClockDriftRejection> {
        self.status.rejected_observations += 1;
        self.status.consecutive_outliers += 1;
        self.status.last_rejection = Some(rejection);
        if immediate_unsafe || self.status.consecutive_outliers >= MAX_CONSECUTIVE_OUTLIERS {
            self.status.state = ClockDriftState::Unsafe;
        }
        Err(rejection)
    }
}

fn signed_difference(left: u64, right: u64) -> i64 {
    if left >= right {
        (left - right).min(i64::MAX as u64) as i64
    } else {
        -((right - left).min(i64::MAX as u64) as i64)
    }
}

fn apply_signed_correction(position: u64, correction: i64) -> u64 {
    if correction >= 0 {
        position.saturating_sub(correction as u64)
    } else {
        position.saturating_add(correction.unsigned_abs())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftAwareJointPair {
    pub generation: u64,
    pub input: MeterFrame,
    pub raw_return: MeterFrame,
    pub corrected_return: MeterFrame,
    pub raw_skew_frames: u64,
    pub corrected_skew_frames: u64,
    pub applied_correction_frames: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftAwareJointStatus {
    pub estimator: ClockDriftStatus,
    pub matcher: LiveJointMatcherStatus,
    pub raw_maximum_skew_frames: u64,
    pub corrected_maximum_skew_frames: u64,
    pub unsafe_shutdowns: usize,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub audio_resampling_performed: bool,
    pub hardware_ready: bool,
}

#[derive(Default)]
pub struct DriftAwareLiveJointMatcher {
    matcher: LiveJointEvidenceMatcher,
    estimator: ClockDriftEstimator,
    raw_returns: BTreeMap<u64, MeterFrame>,
    generation: Option<u64>,
    raw_maximum_skew_frames: u64,
    corrected_maximum_skew_frames: u64,
    unsafe_shutdowns: usize,
}

impl DriftAwareLiveJointMatcher {
    pub fn status(&self) -> DriftAwareJointStatus {
        DriftAwareJointStatus {
            estimator: self.estimator.status(),
            matcher: self.matcher.status(),
            raw_maximum_skew_frames: self.raw_maximum_skew_frames,
            corrected_maximum_skew_frames: self.corrected_maximum_skew_frames,
            unsafe_shutdowns: self.unsafe_shutdowns,
            output_stream_started: false,
            qu16_writes_performed: false,
            audio_resampling_performed: false,
            hardware_ready: false,
        }
    }

    pub fn ingest_input(
        &mut self,
        frame: MeterFrame,
        arrival_ms: u64,
        now_ms: u64,
    ) -> Result<Vec<DriftAwareJointPair>, EngineError> {
        let pairs = self.matcher.ingest_input(frame, arrival_ms, now_ms)?;
        self.finish_pairs(pairs)
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
            self.estimator.reset();
            self.raw_returns.clear();
        }
        let corrected = self.estimator.correct_return_frame(frame.clone())?;
        self.raw_returns.insert(frame.sequence, frame);
        let pairs = self
            .matcher
            .ingest_return(generation, corrected, arrival_ms, now_ms)?;
        self.finish_pairs(pairs)
    }

    pub fn disconnect_return(&mut self) {
        self.matcher.disconnect_return();
        self.estimator.reset();
        self.raw_returns.clear();
        self.generation = None;
    }

    fn finish_pairs(
        &mut self,
        pairs: Vec<LiveJointPair>,
    ) -> Result<Vec<DriftAwareJointPair>, EngineError> {
        let mut finished = Vec::with_capacity(pairs.len());
        for pair in pairs {
            let raw_return = self
                .raw_returns
                .remove(&pair.returned.sequence)
                .ok_or_else(|| EngineError("raw Qu-16 return frame was not retained".into()))?;
            let raw_skew = pair
                .input
                .frame_position
                .abs_diff(raw_return.frame_position);
            let corrected_skew = pair.skew_frames;
            self.raw_maximum_skew_frames = self.raw_maximum_skew_frames.max(raw_skew);
            self.corrected_maximum_skew_frames =
                self.corrected_maximum_skew_frames.max(corrected_skew);
            if self
                .estimator
                .observe(pair.input.frame_position, raw_return.frame_position)
                .is_err()
                && self.estimator.status().state == ClockDriftState::Unsafe
            {
                self.unsafe_shutdowns += 1;
                self.matcher.disconnect_return();
                self.raw_returns.clear();
                return Err(EngineError(
                    "clock drift exceeded the safe timestamp-correction envelope".into(),
                ));
            }
            finished.push(DriftAwareJointPair {
                generation: pair.return_generation,
                input: pair.input,
                raw_return,
                corrected_return: pair.returned,
                raw_skew_frames: raw_skew,
                corrected_skew_frames: corrected_skew,
                applied_correction_frames: raw_skew as i64 - corrected_skew as i64,
            });
        }
        Ok(finished)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockDriftReplayReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub simulated_hours: f64,
    pub injected_drift_ppm: f64,
    pub pair_count: usize,
    pub final_status: DriftAwareJointStatus,
    pub first_pair: DriftAwareJointPair,
    pub last_pair: DriftAwareJointPair,
    pub output_stream_started: bool,
    pub qu16_writes_performed: bool,
    pub audio_resampling_performed: bool,
    pub hardware_ready: bool,
}

pub fn run_default_clock_drift_replay() -> Result<ClockDriftReplayReport, EngineError> {
    let base = 48_000_000_u64;
    let base_offset = 120.0_f64;
    let drift_ppm = 75.0_f64;
    let interval_seconds = 10_u64;
    let observation_count = 721_u64;
    let mut coordinator = DriftAwareLiveJointMatcher::default();
    let mut all_pairs = Vec::new();
    for index in 0..observation_count {
        let elapsed_frames = index * interval_seconds * SAMPLE_RATE as u64;
        let input_position = base + elapsed_frames;
        let drift_frames = elapsed_frames as f64 * drift_ppm / 1_000_000.0;
        let return_position = (input_position as f64 + base_offset + drift_frames).round() as u64;
        let now_ms = index * interval_seconds * 1_000;
        all_pairs.extend(coordinator.ingest_input(
            frame(index + 1, input_position, AsioDirection::Input),
            now_ms,
            now_ms,
        )?);
        all_pairs.extend(coordinator.ingest_return(
            1,
            frame(index + 1, return_position, AsioDirection::Output),
            now_ms,
            now_ms,
        )?);
    }
    let first_pair = all_pairs
        .first()
        .cloned()
        .ok_or_else(|| EngineError("drift replay produced no first pair".into()))?;
    let last_pair = all_pairs
        .last()
        .cloned()
        .ok_or_else(|| EngineError("drift replay produced no last pair".into()))?;
    Ok(ClockDriftReplayReport {
        schema_version: DRIFT_SCHEMA_VERSION,
        mode: "two_hour_timestamp_drift_replay",
        simulated_hours: 2.0,
        injected_drift_ppm: drift_ppm,
        pair_count: all_pairs.len(),
        final_status: coordinator.status(),
        first_pair,
        last_pair,
        output_stream_started: false,
        qu16_writes_performed: false,
        audio_resampling_performed: false,
        hardware_ready: false,
    })
}

fn frame(sequence: u64, position: u64, direction: AsioDirection) -> MeterFrame {
    MeterFrame {
        sequence,
        frame_position: position,
        direction,
        peaks: vec![crate::capture::ChannelPeak {
            driver_index: if direction == AsioDirection::Input {
                2
            } else {
                1
            },
            peak_dbfs: -12.0,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimator_locks_on_slow_seventy_five_ppm_drift() {
        let mut estimator = ClockDriftEstimator::default();
        let base = 1_000_000_u64;
        for index in 0..20_u64 {
            let elapsed = index * 480_000;
            let offset = 120.0 + elapsed as f64 * 75.0 / 1_000_000.0;
            estimator
                .observe(base + elapsed, (base + elapsed) + offset.round() as u64)
                .unwrap();
        }
        let status = estimator.status();
        assert_eq!(status.state, ClockDriftState::Locked);
        assert!((status.estimated_drift_ppm - 75.0).abs() < 1.0);
        assert!(!status.audio_resampling_performed);
    }

    #[test]
    fn excessive_drift_fails_closed() {
        let mut estimator = ClockDriftEstimator::default();
        estimator.observe(1_000_000, 1_000_120).unwrap();
        let error = estimator.observe(1_480_000, 1_480_500).unwrap_err();
        assert_eq!(error, ClockDriftRejection::DriftRateOutOfRange);
        assert_eq!(estimator.status().state, ClockDriftState::Unsafe);
    }

    #[test]
    fn three_clock_steps_make_estimator_unsafe() {
        let mut estimator = ClockDriftEstimator::default();
        estimator.observe(1_000_000, 1_000_120).unwrap();
        for index in 1..=3_u64 {
            let input = 1_000_000 + index * 4_800_000;
            let result = estimator.observe(input, input + 500);
            if index < 3 {
                assert_eq!(result.unwrap_err(), ClockDriftRejection::ResidualOutlier);
            }
        }
        assert_eq!(estimator.status().state, ClockDriftState::Unsafe);
    }

    #[test]
    fn correction_changes_only_timestamp_and_preserves_peaks() {
        let mut estimator = ClockDriftEstimator::default();
        estimator.observe(1_000_000, 1_000_120).unwrap();
        let original = frame(1, 1_000_120, AsioDirection::Output);
        let corrected = estimator.correct_return_frame(original.clone()).unwrap();
        assert_eq!(corrected.frame_position, 1_000_000);
        assert_eq!(corrected.peaks[0].peak_dbfs, original.peaks[0].peak_dbfs);
    }

    #[test]
    fn two_hour_replay_stays_locked_without_resampling_audio() {
        let report = run_default_clock_drift_replay().unwrap();
        assert_eq!(report.pair_count, 721);
        assert_eq!(report.final_status.estimator.state, ClockDriftState::Locked);
        assert!((report.final_status.estimator.estimated_drift_ppm - 75.0).abs() < 0.1);
        assert!(report.last_pair.raw_skew_frames > 20_000);
        assert!(report.last_pair.corrected_skew_frames <= 2);
        assert!(!report.audio_resampling_performed);
        assert!(!report.hardware_ready);
    }
}
