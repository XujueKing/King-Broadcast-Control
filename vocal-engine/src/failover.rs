use crate::{
    blend::FixedDryDelay,
    formant::FormantPreservingPitchShifter,
    multilane::{ThreeLaneVocalEngine, VOCAL_LANE_COUNT},
    EngineError, LoopbackConfig, INTERNAL_FORMAT, SAMPLE_RATE,
};
use serde::Serialize;
use std::{
    array,
    f32::consts::TAU,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

const DEFAULT_FADE_MS: f32 = 20.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SimulatedFailoverFault {
    EngineTimeout,
    InvalidProcessedOutput,
    ControlBridgeDisconnect,
    InputDisconnect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailoverReason {
    Healthy,
    EngineTimeout,
    InvalidProcessedOutput,
    ControlBridgeDisconnect,
    InputUnavailable,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailoverRuntimeState {
    #[default]
    Inactive,
    Processed,
    DryFallback,
    Recovering,
    InputUnavailable,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailoverTelemetrySnapshot {
    pub state: FailoverRuntimeState,
    pub reason: Option<FailoverReason>,
    pub using_dry_fallback: bool,
    pub fresh: bool,
    pub revision: u64,
}

struct FailoverTelemetryShared {
    word: AtomicU64,
}

#[derive(Clone)]
pub struct FailoverTelemetryPublisher(Arc<FailoverTelemetryShared>);

#[derive(Clone)]
pub struct FailoverTelemetryReceiver(Arc<FailoverTelemetryShared>);

pub fn failover_telemetry_channel() -> (FailoverTelemetryPublisher, FailoverTelemetryReceiver) {
    let shared = Arc::new(FailoverTelemetryShared {
        word: AtomicU64::new(0),
    });
    (
        FailoverTelemetryPublisher(Arc::clone(&shared)),
        FailoverTelemetryReceiver(shared),
    )
}

impl FailoverTelemetryPublisher {
    pub fn publish(&self, state: FailoverRuntimeState, reason: Option<FailoverReason>) {
        let using_dry_fallback = matches!(
            state,
            FailoverRuntimeState::DryFallback
                | FailoverRuntimeState::Recovering
                | FailoverRuntimeState::InputUnavailable
        );
        let payload = state_code(state)
            | (reason.map(reason_code).unwrap_or(0) << 4)
            | ((using_dry_fallback as u64) << 8)
            | (1 << 9);
        let _previous =
            self.0
                .word
                .fetch_update(Ordering::Release, Ordering::Relaxed, |previous| {
                    let revision = (previous >> 16).wrapping_add(1);
                    Some(payload | (revision << 16))
                });
    }
}

impl FailoverTelemetryReceiver {
    pub fn snapshot(&self) -> FailoverTelemetrySnapshot {
        let word = self.0.word.load(Ordering::Acquire);
        FailoverTelemetrySnapshot {
            state: state_from_code(word & 0x0f),
            reason: reason_from_code((word >> 4) & 0x0f),
            using_dry_fallback: word & (1 << 8) != 0,
            fresh: word & (1 << 9) != 0,
            revision: word >> 16,
        }
    }
}

fn state_code(state: FailoverRuntimeState) -> u64 {
    match state {
        FailoverRuntimeState::Inactive => 0,
        FailoverRuntimeState::Processed => 1,
        FailoverRuntimeState::DryFallback => 2,
        FailoverRuntimeState::Recovering => 3,
        FailoverRuntimeState::InputUnavailable => 4,
    }
}

fn state_from_code(code: u64) -> FailoverRuntimeState {
    match code {
        1 => FailoverRuntimeState::Processed,
        2 => FailoverRuntimeState::DryFallback,
        3 => FailoverRuntimeState::Recovering,
        4 => FailoverRuntimeState::InputUnavailable,
        _ => FailoverRuntimeState::Inactive,
    }
}

fn reason_code(reason: FailoverReason) -> u64 {
    match reason {
        FailoverReason::Healthy => 1,
        FailoverReason::EngineTimeout => 2,
        FailoverReason::InvalidProcessedOutput => 3,
        FailoverReason::ControlBridgeDisconnect => 4,
        FailoverReason::InputUnavailable => 5,
    }
}

fn reason_from_code(code: u64) -> Option<FailoverReason> {
    match code {
        1 => Some(FailoverReason::Healthy),
        2 => Some(FailoverReason::EngineTimeout),
        3 => Some(FailoverReason::InvalidProcessedOutput),
        4 => Some(FailoverReason::ControlBridgeDisconnect),
        5 => Some(FailoverReason::InputUnavailable),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHealth {
    pub input_available: bool,
    pub engine_responding: bool,
    pub control_bridge_connected: bool,
}

impl Default for RouteHealth {
    fn default() -> Self {
        Self {
            input_available: true,
            engine_responding: true,
            control_bridge_connected: true,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualAsioRouteContract {
    pub adapter_name: &'static str,
    pub evidence_class: &'static str,
    pub sample_rate: u32,
    pub internal_format: &'static str,
    pub block_frames: usize,
    pub driver_input_indices: [usize; VOCAL_LANE_COUNT],
    pub driver_return_indices: [usize; VOCAL_LANE_COUNT],
    pub physical_hardware: bool,
    pub qu16_mapping_verified: bool,
}

impl VirtualAsioRouteContract {
    pub fn new(block_frames: usize) -> Result<Self, EngineError> {
        if block_frames == 0 || block_frames > 1_024 {
            return Err(EngineError("虚拟 ASIO block_frames 必须在 1..=1024".into()));
        }
        Ok(Self {
            adapter_name: "KING Virtual ASIO (simulation only)",
            evidence_class: "deterministic_software_only",
            sample_rate: SAMPLE_RATE,
            internal_format: INTERNAL_FORMAT,
            block_frames,
            driver_input_indices: [0, 1, 2],
            driver_return_indices: [3, 4, 5],
            physical_hardware: false,
            qu16_mapping_verified: false,
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct FailoverFrameResult {
    pub output: [f32; VOCAL_LANE_COUNT],
    pub processed_mix: f32,
    pub reason: Option<FailoverReason>,
}

pub struct ThreeLaneFailoverRouter {
    dry_delays: [FixedDryDelay; VOCAL_LANE_COUNT],
    processed_mix: f32,
    input_gain: f32,
    fade_step: f32,
    fallback_frames: u64,
    input_unavailable_frames: u64,
    invalid_processed_samples: u64,
    last_output: [f32; VOCAL_LANE_COUNT],
    telemetry: Option<FailoverTelemetryPublisher>,
    last_telemetry: Option<(FailoverRuntimeState, Option<FailoverReason>)>,
}

impl ThreeLaneFailoverRouter {
    pub fn new(fade_ms: f32) -> Result<Self, EngineError> {
        if !fade_ms.is_finite() || !(2.0..=100.0).contains(&fade_ms) {
            return Err(EngineError("故障回退淡变必须在 2..=100 ms".into()));
        }
        let latency = FormantPreservingPitchShifter::algorithmic_latency_frames();
        Ok(Self {
            dry_delays: array::from_fn(|_| FixedDryDelay::new(latency).expect("fixed latency")),
            processed_mix: 1.0,
            input_gain: 1.0,
            fade_step: 1.0 / (fade_ms * SAMPLE_RATE as f32 / 1_000.0),
            fallback_frames: 0,
            input_unavailable_frames: 0,
            invalid_processed_samples: 0,
            last_output: [0.0; VOCAL_LANE_COUNT],
            telemetry: None,
            last_telemetry: None,
        })
    }

    pub fn with_telemetry(
        fade_ms: f32,
        telemetry: FailoverTelemetryPublisher,
    ) -> Result<Self, EngineError> {
        let mut router = Self::new(fade_ms)?;
        router.telemetry = Some(telemetry);
        Ok(router)
    }

    pub fn process_frame(
        &mut self,
        input: [f32; VOCAL_LANE_COUNT],
        processed: Option<[f32; VOCAL_LANE_COUNT]>,
        health: RouteHealth,
    ) -> FailoverFrameResult {
        let mut dry = [0.0; VOCAL_LANE_COUNT];
        for lane in 0..VOCAL_LANE_COUNT {
            dry[lane] = self.dry_delays[lane].process_sample(input[lane]);
        }
        let processed_is_finite = processed
            .as_ref()
            .is_some_and(|samples| samples.iter().all(|sample| sample.is_finite()));
        let reason = if !health.input_available {
            Some(FailoverReason::InputUnavailable)
        } else if !health.engine_responding {
            Some(FailoverReason::EngineTimeout)
        } else if !health.control_bridge_connected {
            Some(FailoverReason::ControlBridgeDisconnect)
        } else if !processed_is_finite {
            Some(FailoverReason::InvalidProcessedOutput)
        } else {
            None
        };
        let target_mix = if reason.is_none() { 1.0 } else { 0.0 };
        self.processed_mix = move_towards(self.processed_mix, target_mix, self.fade_step);
        self.input_gain = move_towards(
            self.input_gain,
            if health.input_available { 1.0 } else { 0.0 },
            self.fade_step,
        );
        let invalid_processed = processed.is_some() && !processed_is_finite;
        let safe_processed = if health.input_available && processed_is_finite {
            processed
        } else {
            None
        };
        if invalid_processed {
            self.invalid_processed_samples += VOCAL_LANE_COUNT as u64;
        }
        let mut output = [0.0; VOCAL_LANE_COUNT];
        for lane in 0..VOCAL_LANE_COUNT {
            let wet = safe_processed.map_or(self.last_output[lane], |samples| samples[lane]);
            output[lane] = ((dry[lane] * (1.0 - self.processed_mix) + wet * self.processed_mix)
                * self.input_gain)
                .clamp(-1.0, 1.0);
        }
        self.last_output = output;
        if reason.is_some() {
            self.fallback_frames += 1;
        }
        if reason == Some(FailoverReason::InputUnavailable) {
            self.input_unavailable_frames += 1;
        }
        let runtime_state = if reason == Some(FailoverReason::InputUnavailable) {
            FailoverRuntimeState::InputUnavailable
        } else if reason.is_some() {
            FailoverRuntimeState::DryFallback
        } else if self.processed_mix < 0.999 {
            FailoverRuntimeState::Recovering
        } else {
            FailoverRuntimeState::Processed
        };
        let telemetry_value = (runtime_state, reason);
        if self.last_telemetry != Some(telemetry_value) {
            if let Some(telemetry) = &self.telemetry {
                telemetry.publish(runtime_state, reason);
            }
            self.last_telemetry = Some(telemetry_value);
        }
        FailoverFrameResult {
            output,
            processed_mix: self.processed_mix,
            reason,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailoverScenarioReport {
    pub fault: SimulatedFailoverFault,
    pub fallback_reason: FailoverReason,
    pub fallback_frames: u64,
    pub input_unavailable_frames: u64,
    pub invalid_processed_samples: u64,
    pub minimum_processed_mix: f32,
    pub recovered_to_processed: bool,
    pub output_rms_during_fault: [f32; VOCAL_LANE_COUNT],
    pub non_finite_output_samples: u64,
    pub crosstalk_maximum: f32,
    pub maximum_output_step: f32,
    pub telemetry_revision: u64,
    pub final_runtime_state: FailoverRuntimeState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailoverMatrixReport {
    pub schema_version: u32,
    pub stage: &'static str,
    pub evidence_class: &'static str,
    pub route: VirtualAsioRouteContract,
    pub fade_ms: f32,
    pub scenarios: Vec<FailoverScenarioReport>,
    pub all_outputs_finite: bool,
    pub all_scenarios_recovered: bool,
    pub physical_audio_started: bool,
    pub direct_qu16_dry_fallback_verified: bool,
    pub dp440_route_verified: bool,
}

pub fn run_failover_matrix(
    duration_seconds: f64,
    block_frames: usize,
) -> Result<FailoverMatrixReport, EngineError> {
    if !duration_seconds.is_finite() || !(1.0..=30.0).contains(&duration_seconds) {
        return Err(EngineError("故障矩阵时长必须在 1..=30 秒".into()));
    }
    let route = VirtualAsioRouteContract::new(block_frames)?;
    let faults = [
        SimulatedFailoverFault::EngineTimeout,
        SimulatedFailoverFault::InvalidProcessedOutput,
        SimulatedFailoverFault::ControlBridgeDisconnect,
        SimulatedFailoverFault::InputDisconnect,
    ];
    let mut scenarios = Vec::with_capacity(faults.len());
    for fault in faults {
        scenarios.push(run_scenario(fault, duration_seconds, block_frames)?);
    }
    let all_outputs_finite = scenarios
        .iter()
        .all(|scenario| scenario.non_finite_output_samples == 0);
    let all_scenarios_recovered = scenarios
        .iter()
        .all(|scenario| scenario.recovered_to_processed);
    Ok(FailoverMatrixReport {
        schema_version: 1,
        stage: if all_outputs_finite && all_scenarios_recovered {
            "P15_VIRTUAL_FAILOVER_PASSED"
        } else {
            "P15_VIRTUAL_FAILOVER_DEGRADED"
        },
        evidence_class: "deterministic_software_only",
        route,
        fade_ms: DEFAULT_FADE_MS,
        scenarios,
        all_outputs_finite,
        all_scenarios_recovered,
        physical_audio_started: false,
        direct_qu16_dry_fallback_verified: false,
        dp440_route_verified: false,
    })
}

fn run_scenario(
    fault: SimulatedFailoverFault,
    duration_seconds: f64,
    block_frames: usize,
) -> Result<FailoverScenarioReport, EngineError> {
    let frames = (duration_seconds * SAMPLE_RATE as f64).round() as usize;
    let fault_start = frames * 2 / 5;
    let fault_end = frames * 3 / 5;
    let config = LoopbackConfig {
        pitch_correction_enabled: true,
        vocal_dynamics_enabled: true,
        vocal_quality_enabled: true,
        adaptive_vocal_blend_enabled: true,
        ..LoopbackConfig::default()
    };
    let mut engine = ThreeLaneVocalEngine::new(&config)?;
    let (telemetry_publisher, telemetry_receiver) = failover_telemetry_channel();
    let mut router = ThreeLaneFailoverRouter::with_telemetry(DEFAULT_FADE_MS, telemetry_publisher)?;
    let mut fault_energy = [0.0_f64; VOCAL_LANE_COUNT];
    let mut fault_samples = 0_u64;
    let mut non_finite = 0_u64;
    let mut minimum_mix = 1.0_f32;
    let mut observed_reason = FailoverReason::Healthy;
    let mut previous_output = [0.0_f32; VOCAL_LANE_COUNT];
    let mut maximum_output_step = 0.0_f32;

    for block_start in (0..frames).step_by(block_frames) {
        let block_end = (block_start + block_frames).min(frames);
        for frame in block_start..block_end {
            let active = (fault_start..fault_end).contains(&frame);
            let time = frame as f32 / SAMPLE_RATE as f32;
            let envelope = (time * 9.0).min(1.0) * 0.18;
            let mut input = [
                envelope * (TAU * 440.0 * time).sin(),
                envelope * (TAU * 493.88 * time).sin(),
                envelope * (TAU * 523.25 * time).sin(),
            ];
            let mut health = RouteHealth::default();
            if active && fault == SimulatedFailoverFault::InputDisconnect {
                input = [0.0; VOCAL_LANE_COUNT];
                health.input_available = false;
            }
            let mut processed = Some(engine.process_frame(input).output);
            if active {
                match fault {
                    SimulatedFailoverFault::EngineTimeout => {
                        health.engine_responding = false;
                        processed = None;
                    }
                    SimulatedFailoverFault::InvalidProcessedOutput => {
                        processed = Some([f32::NAN, f32::INFINITY, f32::NEG_INFINITY]);
                    }
                    SimulatedFailoverFault::ControlBridgeDisconnect => {
                        health.control_bridge_connected = false;
                    }
                    SimulatedFailoverFault::InputDisconnect => {}
                }
            }
            let result = router.process_frame(input, processed, health);
            minimum_mix = minimum_mix.min(result.processed_mix);
            if let Some(reason) = result.reason {
                observed_reason = reason;
            }
            for (lane, energy) in fault_energy.iter_mut().enumerate() {
                let output = result.output[lane];
                maximum_output_step =
                    maximum_output_step.max((output - previous_output[lane]).abs());
                previous_output[lane] = output;
                if !output.is_finite() {
                    non_finite += 1;
                }
                if active {
                    *energy += (output * output) as f64;
                }
            }
            if active {
                fault_samples += 1;
            }
        }
    }
    let output_rms_during_fault =
        array::from_fn(|lane| (fault_energy[lane] / fault_samples.max(1) as f64).sqrt() as f32);
    let telemetry = telemetry_receiver.snapshot();
    Ok(FailoverScenarioReport {
        fault,
        fallback_reason: observed_reason,
        fallback_frames: router.fallback_frames,
        input_unavailable_frames: router.input_unavailable_frames,
        invalid_processed_samples: router.invalid_processed_samples,
        minimum_processed_mix: minimum_mix,
        recovered_to_processed: router.processed_mix >= 0.999,
        output_rms_during_fault,
        non_finite_output_samples: non_finite,
        crosstalk_maximum: run_failover_crosstalk_probe(fault)?,
        maximum_output_step,
        telemetry_revision: telemetry.revision,
        final_runtime_state: telemetry.state,
    })
}

fn run_failover_crosstalk_probe(fault: SimulatedFailoverFault) -> Result<f32, EngineError> {
    let config = LoopbackConfig {
        pitch_correction_enabled: true,
        vocal_dynamics_enabled: true,
        vocal_quality_enabled: true,
        adaptive_vocal_blend_enabled: true,
        ..LoopbackConfig::default()
    };
    let mut engine = ThreeLaneVocalEngine::new(&config)?;
    let mut router = ThreeLaneFailoverRouter::new(DEFAULT_FADE_MS)?;
    let mut maximum = 0.0_f32;
    for frame in 0..(SAMPLE_RATE as usize / 4) {
        let time = frame as f32 / SAMPLE_RATE as f32;
        let mut input = [0.18 * (TAU * 440.0 * time).sin(), 0.0, 0.0];
        let mut health = RouteHealth::default();
        if fault == SimulatedFailoverFault::InputDisconnect {
            input = [0.0; VOCAL_LANE_COUNT];
            health.input_available = false;
        }
        let mut processed = Some(engine.process_frame(input).output);
        match fault {
            SimulatedFailoverFault::EngineTimeout => {
                health.engine_responding = false;
                processed = None;
            }
            SimulatedFailoverFault::InvalidProcessedOutput => {
                processed = Some([f32::NAN, f32::INFINITY, f32::NEG_INFINITY]);
            }
            SimulatedFailoverFault::ControlBridgeDisconnect => {
                health.control_bridge_connected = false;
            }
            SimulatedFailoverFault::InputDisconnect => {}
        }
        let output = router.process_frame(input, processed, health).output;
        maximum = maximum.max(output[1].abs()).max(output[2].abs());
    }
    Ok(maximum)
}

fn move_towards(current: f32, target: f32, step: f32) -> f32 {
    if current < target {
        (current + step).min(target)
    } else {
        (current - step).max(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_route_is_explicitly_not_hardware_evidence() {
        let route = VirtualAsioRouteContract::new(128).unwrap();
        assert!(!route.physical_hardware);
        assert!(!route.qu16_mapping_verified);
        assert_eq!(route.driver_input_indices, [0, 1, 2]);
        assert_eq!(route.driver_return_indices, [3, 4, 5]);
    }

    #[test]
    fn invalid_output_falls_back_without_producing_non_finite_audio() {
        let mut router = ThreeLaneFailoverRouter::new(12.0).unwrap();
        let result = router.process_frame(
            [0.1, 0.2, 0.3],
            Some([f32::NAN, f32::INFINITY, f32::NEG_INFINITY]),
            RouteHealth::default(),
        );
        assert_eq!(result.reason, Some(FailoverReason::InvalidProcessedOutput));
        assert!(result.output.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn timeout_uses_latency_aligned_dry_and_then_recovers() {
        let mut router = ThreeLaneFailoverRouter::new(2.0).unwrap();
        for _ in 0..256 {
            router.process_frame(
                [0.2, 0.0, 0.0],
                None,
                RouteHealth {
                    engine_responding: false,
                    ..RouteHealth::default()
                },
            );
        }
        assert_eq!(router.processed_mix, 0.0);
        for _ in 0..256 {
            router.process_frame(
                [0.2, 0.0, 0.0],
                Some([0.2, 0.0, 0.0]),
                RouteHealth::default(),
            );
        }
        assert_eq!(router.processed_mix, 1.0);
    }

    #[test]
    fn complete_fault_matrix_is_finite_recovered_and_never_physical() {
        let report = run_failover_matrix(1.0, 128).unwrap();
        assert_eq!(report.stage, "P15_VIRTUAL_FAILOVER_PASSED");
        assert!(report.all_outputs_finite);
        assert!(report.all_scenarios_recovered);
        assert!(report
            .scenarios
            .iter()
            .all(|scenario| scenario.maximum_output_step < 0.05));
        assert!(report
            .scenarios
            .iter()
            .all(|scenario| scenario.crosstalk_maximum == 0.0));
        assert!(!report.physical_audio_started);
        assert!(!report.direct_qu16_dry_fallback_verified);
        assert!(!report.dp440_route_verified);
    }
}
