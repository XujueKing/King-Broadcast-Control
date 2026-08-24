use crate::{
    preset::{ThreeLanePresetBank, VocalLaneId, VocalPreset},
    EngineError, LiveVocalProcessor, LoopbackConfig, INTERNAL_FORMAT, SAMPLE_RATE,
};
use serde::Serialize;
use std::{f32::consts::TAU, time::Instant};

pub const VOCAL_LANE_COUNT: usize = 3;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16MultichannelContract {
    pub sample_rate: u32,
    pub internal_format: &'static str,
    pub block_frames: usize,
    pub required_host: &'static str,
    pub device_name_hint: &'static str,
    pub qu_input_channels: [u8; VOCAL_LANE_COUNT],
    pub driver_input_indices: [Option<usize>; VOCAL_LANE_COUNT],
    pub driver_return_indices: [Option<usize>; VOCAL_LANE_COUNT],
    pub hardware_binding_status: &'static str,
}

impl Default for Qu16MultichannelContract {
    fn default() -> Self {
        Self {
            sample_rate: SAMPLE_RATE,
            internal_format: INTERNAL_FORMAT,
            block_frames: 128,
            required_host: "ASIO",
            device_name_hint: "Qu ASIO Driver",
            qu_input_channels: [1, 2, 3],
            driver_input_indices: [None; VOCAL_LANE_COUNT],
            driver_return_indices: [None; VOCAL_LANE_COUNT],
            hardware_binding_status: "unbound_requires_qu16_hardware_validation",
        }
    }
}

impl Qu16MultichannelContract {
    pub fn validate(&self) -> Result<(), EngineError> {
        if self.sample_rate != SAMPLE_RATE {
            return Err(EngineError("多通道人声后端固定使用 48 kHz".into()));
        }
        if self.block_frames == 0 || self.block_frames > 1_024 {
            return Err(EngineError("多通道 block_frames 必须在 1..=1024".into()));
        }
        validate_unique("输入", &self.driver_input_indices)?;
        validate_unique("返回", &self.driver_return_indices)?;
        Ok(())
    }

    pub fn hardware_ready(&self) -> bool {
        self.validate().is_ok()
            && self.driver_input_indices.iter().all(Option::is_some)
            && self.driver_return_indices.iter().all(Option::is_some)
    }
}

fn validate_unique(
    label: &str,
    channels: &[Option<usize>; VOCAL_LANE_COUNT],
) -> Result<(), EngineError> {
    for left in 0..channels.len() {
        for right in (left + 1)..channels.len() {
            if channels[left].is_some() && channels[left] == channels[right] {
                return Err(EngineError(format!("{label}通道不能重复映射")));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MultiLaneFrameResult {
    pub output: [f32; VOCAL_LANE_COUNT],
    pub quality_score: [Option<f32>; VOCAL_LANE_COUNT],
    pub corrected_mix: [Option<f32>; VOCAL_LANE_COUNT],
}

pub struct ThreeLaneVocalEngine {
    processors: [LiveVocalProcessor; VOCAL_LANE_COUNT],
    controls: ThreeLanePresetBank,
}

impl ThreeLaneVocalEngine {
    pub fn new(config: &LoopbackConfig) -> Result<Self, EngineError> {
        let controls = ThreeLanePresetBank::new(config.vocal_preset);
        let processors = [
            LiveVocalProcessor::new(config, controls.control(VocalLaneId::Mic1).receiver())?,
            LiveVocalProcessor::new(config, controls.control(VocalLaneId::Mic2).receiver())?,
            LiveVocalProcessor::new(config, controls.control(VocalLaneId::Mic3).receiver())?,
        ];
        Ok(Self {
            processors,
            controls,
        })
    }

    pub fn set_preset(&self, lane: VocalLaneId, preset: VocalPreset) -> u64 {
        self.controls.request(lane, preset)
    }

    pub fn process_frame(&mut self, input: [f32; VOCAL_LANE_COUNT]) -> MultiLaneFrameResult {
        let mut result = MultiLaneFrameResult::default();
        for (lane, sample) in input.into_iter().enumerate() {
            let (output, quality, corrected_mix) = self.processors[lane].process_sample(sample);
            result.output[lane] = output;
            result.quality_score[lane] = quality.map(|value| value.quality_score);
            result.corrected_mix[lane] = corrected_mix;
        }
        result
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiLaneChannelReport {
    pub lane: VocalLaneId,
    pub preset: VocalPreset,
    pub synthetic_detune_cents: f32,
    pub input_rms: f32,
    pub output_rms: f32,
    pub output_peak: f32,
    pub latest_quality_score: Option<f32>,
    pub latest_corrected_mix: Option<f32>,
    pub non_finite_samples: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiLaneSimulationReport {
    pub schema_version: u32,
    pub stage: &'static str,
    pub evidence_class: &'static str,
    pub sample_rate: u32,
    pub block_frames: usize,
    pub duration_seconds: f64,
    pub channel_count: usize,
    pub channels: [MultiLaneChannelReport; VOCAL_LANE_COUNT],
    pub crosstalk_probe_maximum: f32,
    pub processing_mean_ms_per_block: f64,
    pub processing_p99_ms_per_block: f64,
    pub realtime_block_budget_ms: f64,
    pub deadline_misses: u64,
    pub backend_contract: Qu16MultichannelContract,
    pub physical_audio_started: bool,
}

pub fn run_multilane_simulation(
    duration_seconds: f64,
    block_frames: usize,
) -> Result<MultiLaneSimulationReport, EngineError> {
    if !duration_seconds.is_finite() || !(0.25..=60.0).contains(&duration_seconds) {
        return Err(EngineError("三路模拟时长必须在 0.25..=60 秒".into()));
    }
    if block_frames == 0 || block_frames > 1_024 {
        return Err(EngineError("三路模拟 block_frames 必须在 1..=1024".into()));
    }
    let config = LoopbackConfig {
        pitch_correction_enabled: true,
        vocal_dynamics_enabled: true,
        vocal_quality_enabled: true,
        adaptive_vocal_blend_enabled: true,
        maximum_correction_cents: 120.0,
        ..LoopbackConfig::default()
    };
    let mut engine = ThreeLaneVocalEngine::new(&config)?;
    let presets = [
        VocalPreset::Natural,
        VocalPreset::Professional,
        VocalPreset::Strong,
    ];
    engine.set_preset(VocalLaneId::Mic1, presets[0]);
    engine.set_preset(VocalLaneId::Mic2, presets[1]);
    engine.set_preset(VocalLaneId::Mic3, presets[2]);
    let detune = [0.0_f32, 35.0, -35.0];
    let frames = (duration_seconds * SAMPLE_RATE as f64).round() as usize;
    let mut input_energy = [0.0_f64; VOCAL_LANE_COUNT];
    let mut output_energy = [0.0_f64; VOCAL_LANE_COUNT];
    let mut output_peak = [0.0_f32; VOCAL_LANE_COUNT];
    let mut latest_quality = [None; VOCAL_LANE_COUNT];
    let mut latest_mix = [None; VOCAL_LANE_COUNT];
    let mut non_finite = [0_u64; VOCAL_LANE_COUNT];
    let mut block_times = Vec::with_capacity(frames.div_ceil(block_frames));
    let block_budget_ms = block_frames as f64 / SAMPLE_RATE as f64 * 1_000.0;
    let mut deadline_misses = 0_u64;

    for block_start in (0..frames).step_by(block_frames) {
        let started = Instant::now();
        let block_end = (block_start + block_frames).min(frames);
        for frame in block_start..block_end {
            let time = frame as f32 / SAMPLE_RATE as f32;
            let envelope = (time * 7.0).min(1.0) * 0.22;
            let input = std::array::from_fn(|lane| {
                let frequency = 440.0 * 2.0_f32.powf(detune[lane] / 1_200.0);
                envelope * (TAU * frequency * time).sin()
            });
            let result = engine.process_frame(input);
            for lane in 0..VOCAL_LANE_COUNT {
                input_energy[lane] += (input[lane] * input[lane]) as f64;
                let output = result.output[lane];
                if output.is_finite() {
                    output_energy[lane] += (output * output) as f64;
                    output_peak[lane] = output_peak[lane].max(output.abs());
                } else {
                    non_finite[lane] += 1;
                }
                if result.quality_score[lane].is_some() {
                    latest_quality[lane] = result.quality_score[lane];
                }
                if result.corrected_mix[lane].is_some() {
                    latest_mix[lane] = result.corrected_mix[lane];
                }
            }
        }
        let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
        if elapsed > block_budget_ms {
            deadline_misses += 1;
        }
        block_times.push(elapsed);
    }

    let crosstalk_probe_maximum = crosstalk_probe(&config)?;
    block_times.sort_by(f64::total_cmp);
    let processing_mean_ms_per_block =
        block_times.iter().sum::<f64>() / block_times.len().max(1) as f64;
    let p99_index = ((block_times.len() as f64 * 0.99).ceil() as usize)
        .saturating_sub(1)
        .min(block_times.len().saturating_sub(1));
    let processing_p99_ms_per_block = block_times.get(p99_index).copied().unwrap_or(0.0);
    let lanes = [VocalLaneId::Mic1, VocalLaneId::Mic2, VocalLaneId::Mic3];
    let channels = std::array::from_fn(|lane| MultiLaneChannelReport {
        lane: lanes[lane],
        preset: presets[lane],
        synthetic_detune_cents: detune[lane],
        input_rms: (input_energy[lane] / frames as f64).sqrt() as f32,
        output_rms: (output_energy[lane] / frames as f64).sqrt() as f32,
        output_peak: output_peak[lane],
        latest_quality_score: latest_quality[lane],
        latest_corrected_mix: latest_mix[lane],
        non_finite_samples: non_finite[lane],
    });
    let contract = Qu16MultichannelContract {
        block_frames,
        ..Qu16MultichannelContract::default()
    };
    Ok(MultiLaneSimulationReport {
        schema_version: 1,
        stage: if deadline_misses == 0 && crosstalk_probe_maximum <= f32::EPSILON {
            "P13_MULTILANE_SIMULATION_PASSED"
        } else {
            "P13_MULTILANE_SIMULATION_DEGRADED"
        },
        evidence_class: "deterministic_software_only",
        sample_rate: SAMPLE_RATE,
        block_frames,
        duration_seconds: frames as f64 / SAMPLE_RATE as f64,
        channel_count: VOCAL_LANE_COUNT,
        channels,
        crosstalk_probe_maximum,
        processing_mean_ms_per_block,
        processing_p99_ms_per_block,
        realtime_block_budget_ms: block_budget_ms,
        deadline_misses,
        backend_contract: contract,
        physical_audio_started: false,
    })
}

fn crosstalk_probe(config: &LoopbackConfig) -> Result<f32, EngineError> {
    let mut engine = ThreeLaneVocalEngine::new(config)?;
    let mut maximum = 0.0_f32;
    for frame in 0..(SAMPLE_RATE as usize / 4) {
        let time = frame as f32 / SAMPLE_RATE as f32;
        let output = engine.process_frame([0.2 * (TAU * 440.0 * time).sin(), 0.0, 0.0]);
        maximum = maximum
            .max(output.output[1].abs())
            .max(output.output[2].abs());
    }
    Ok(maximum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_contract_rejects_duplicate_driver_channels() {
        let contract = Qu16MultichannelContract {
            driver_input_indices: [Some(0), Some(0), Some(2)],
            ..Qu16MultichannelContract::default()
        };
        assert!(contract.validate().is_err());
    }

    #[test]
    fn unverified_contract_never_claims_hardware_ready() {
        assert!(!Qu16MultichannelContract::default().hardware_ready());
    }

    #[test]
    fn three_lane_engine_has_no_digital_crosstalk() {
        let config = LoopbackConfig {
            pitch_correction_enabled: true,
            vocal_quality_enabled: true,
            adaptive_vocal_blend_enabled: true,
            ..LoopbackConfig::default()
        };
        assert_eq!(crosstalk_probe(&config).unwrap(), 0.0);
    }

    #[test]
    fn multilane_simulation_is_finite_and_within_budget() {
        let report = run_multilane_simulation(0.5, 128).unwrap();
        assert_eq!(report.channel_count, 3);
        assert_eq!(report.crosstalk_probe_maximum, 0.0);
        assert_eq!(report.deadline_misses, 0);
        assert!(report
            .channels
            .iter()
            .all(|channel| channel.non_finite_samples == 0));
    }
}
