use crate::{
    correction::{
        scale_mask, CorrectionDecision, CorrectionPlanner, CorrectionPlannerConfig,
        CorrectionState, ScaleMode, TargetSource, CHROMATIC_MASK,
    },
    dynamics::{VocalDynamicsConfig, VocalDynamicsProcessor},
    formant::{FormantPreservingPitchShifter, FormantShifterConfig},
    pitch::{PitchObservation, PitchTracker, PitchTrackerConfig},
    reference::{ReferenceBuildConfig, ReferenceVocalMap},
    EngineError, INTERNAL_FORMAT, SAMPLE_RATE,
};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use serde::Serialize;
use std::{
    f32::consts::TAU,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SimulationFault {
    #[default]
    None,
    Underrun,
    Disconnect,
    CpuOverload,
}

impl FromStr for SimulationFault {
    type Err = EngineError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "none" => Ok(Self::None),
            "underrun" => Ok(Self::Underrun),
            "disconnect" => Ok(Self::Disconnect),
            "cpu-overload" | "overload" => Ok(Self::CpuOverload),
            _ => Err(EngineError(format!(
                "未知模拟故障 {value}；可选 none/underrun/disconnect/cpu-overload"
            ))),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SimulationConfig {
    pub input_wav: Option<PathBuf>,
    pub output_dir: PathBuf,
    pub duration_seconds: f64,
    pub block_frames: usize,
    pub gain_db: f32,
    pub fault: SimulationFault,
    pub correction_strength: f32,
    pub correction_deadband_cents: f32,
    pub maximum_correction_cents: f32,
    pub key_tonic: Option<u8>,
    pub scale_mode: Option<ScaleMode>,
    pub reference_map: Option<PathBuf>,
    pub synthetic_detune_cents: f32,
    pub audio_transform_enabled: bool,
    pub vocal_dynamics_enabled: bool,
}

impl Default for SimulationConfig {
    fn default() -> Self {
        Self {
            input_wav: None,
            output_dir: PathBuf::from("artifacts/simulation"),
            duration_seconds: 5.0,
            block_frames: 128,
            gain_db: 0.0,
            fault: SimulationFault::None,
            correction_strength: 0.75,
            correction_deadband_cents: 8.0,
            maximum_correction_cents: 45.0,
            key_tonic: None,
            scale_mode: None,
            reference_map: None,
            synthetic_detune_cents: 0.0,
            audio_transform_enabled: true,
            vocal_dynamics_enabled: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationReport {
    pub schema_version: u32,
    pub stage: String,
    pub backend: String,
    pub evidence_class: String,
    pub sample_rate: u32,
    pub internal_format: String,
    pub source: String,
    pub duration_seconds: f64,
    pub block_frames: usize,
    pub blocks: u64,
    pub frames: u64,
    pub gain_db: f32,
    pub fault: SimulationFault,
    pub simulated_input_buffer_ms: f64,
    pub simulated_output_buffer_ms: f64,
    pub simulated_transport_ms: f64,
    pub round_trip_ms: Option<f64>,
    pub round_trip_evidence: String,
    pub processing_mean_ms: f64,
    pub processing_max_ms: f64,
    pub processing_p95_ms: f64,
    pub processing_p99_ms: f64,
    pub deadline_misses: u64,
    pub underrun_events: u64,
    pub dropped_frames: u64,
    pub disconnect_events: u64,
    pub nan_samples: u64,
    pub raw_peak: f32,
    pub processed_peak: f32,
    pub pitch_observations: u64,
    pub voiced_observations: u64,
    pub voiced_ratio: f64,
    pub f0_mean_hz: Option<f32>,
    pub f0_min_hz: Option<f32>,
    pub f0_max_hz: Option<f32>,
    pub confidence_mean: f32,
    pub correction_observations: u64,
    pub active_correction_observations: u64,
    pub deadband_observations: u64,
    pub bypassed_correction_observations: u64,
    pub mean_absolute_cents_error: f32,
    pub mean_absolute_applied_cents: f32,
    pub maximum_absolute_applied_cents: f32,
    pub chromatic_target_observations: u64,
    pub scale_target_observations: u64,
    pub reference_target_observations: u64,
    pub generated_reference_segments: u64,
    pub reference_input: Option<String>,
    pub audio_transform: String,
    pub formant_preservation: bool,
    pub transform_algorithmic_latency_ms: f32,
    pub transient_bypass_samples: u64,
    pub invalid_transform_fallback_samples: u64,
    pub level_match_gain_db: f32,
    pub raw_rms_dbfs: f32,
    pub processed_rms_dbfs: f32,
    pub processed_f0_mean_hz: Option<f32>,
    pub measured_pitch_shift_cents: Option<f32>,
    pub mean_processed_reference_error_cents: Option<f32>,
    pub vocal_dynamics: String,
    pub dynamics_deesser_active_samples: u64,
    pub dynamics_compressor_active_samples: u64,
    pub dynamics_limiter_active_samples: u64,
    pub maximum_deesser_reduction_db: f32,
    pub maximum_compressor_reduction_db: f32,
    pub maximum_limiter_reduction_db: f32,
    pub invalid_dynamics_fallback_samples: u64,
    pub raw_wav: String,
    pub processed_wav: String,
    pub metrics_json: String,
    pub pitch_json: String,
    pub correction_json: String,
    pub generated_reference_json: String,
}

pub fn run_simulation(config: &SimulationConfig) -> Result<SimulationReport, EngineError> {
    validate(config)?;
    fs::create_dir_all(&config.output_dir)
        .map_err(|error| EngineError(format!("无法创建模拟证据目录：{error}")))?;
    let loaded_reference = config
        .reference_map
        .as_deref()
        .map(ReferenceVocalMap::load)
        .transpose()?;
    let reference_input = config
        .reference_map
        .as_ref()
        .map(|path| path.display().to_string());

    let (source, raw) = match &config.input_wav {
        Some(path) => (path.display().to_string(), read_mono_float32_48k(path)?),
        None => (
            "synthetic_vocal_like_signal".into(),
            synthetic_vocal(config.duration_seconds, config.synthetic_detune_cents),
        ),
    };
    let requested_frames = (config.duration_seconds * SAMPLE_RATE as f64).round() as usize;
    let raw = fit_duration(raw, requested_frames);
    let mut processed = vec![0.0_f32; raw.len()];
    let gain = 10.0_f32.powf(config.gain_db / 20.0);
    let block_budget = config.block_frames as f64 / SAMPLE_RATE as f64;
    let mut processing_ms = Vec::with_capacity(raw.len().div_ceil(config.block_frames));
    let mut deadline_misses = 0_u64;
    let mut underrun_events = 0_u64;
    let mut dropped_frames = 0_u64;
    let mut disconnect_events = 0_u64;
    let mut pitch_tracker = PitchTracker::new(PitchTrackerConfig::default())?;
    let mut pitch_observations = Vec::<PitchObservation>::new();
    let mut correction_planner = CorrectionPlanner::new(CorrectionPlannerConfig {
        hop_frames: config.block_frames,
        strength: config.correction_strength,
        deadband_cents: config.correction_deadband_cents,
        maximum_correction_cents: config.maximum_correction_cents,
        allowed_pitch_classes: match (config.key_tonic, config.scale_mode) {
            (Some(tonic), Some(mode)) => scale_mask(tonic, mode),
            _ => CHROMATIC_MASK,
        },
        ..CorrectionPlannerConfig::default()
    })?;
    let mut correction_decisions = Vec::<CorrectionDecision>::new();
    let mut pitch_shifter = FormantPreservingPitchShifter::new(FormantShifterConfig {
        maximum_correction_cents: config.maximum_correction_cents,
        ..FormantShifterConfig::default()
    })?;
    let mut current_correction_cents = 0.0_f32;
    let mut vocal_dynamics = config
        .vocal_dynamics_enabled
        .then(|| VocalDynamicsProcessor::new(VocalDynamicsConfig::default()))
        .transpose()?;
    let mut dynamics_scratch = vec![0.0_f32; config.block_frames];

    let disconnect_start = raw.len() / 2;
    let disconnect_end = (disconnect_start + SAMPLE_RATE as usize / 4).min(raw.len());
    for (block_index, (input, output)) in raw
        .chunks(config.block_frames)
        .zip(processed.chunks_mut(config.block_frames))
        .enumerate()
    {
        let started_at = Instant::now();
        let inject_underrun =
            config.fault == SimulationFault::Underrun && block_index > 0 && block_index % 50 == 0;
        let inject_disconnect = config.fault == SimulationFault::Disconnect
            && block_index * config.block_frames < disconnect_end
            && (block_index + 1) * config.block_frames > disconnect_start;

        let pitch_input: &[f32] = if inject_disconnect { output } else { input };
        if let Some(observation) = pitch_tracker.process_block(pitch_input) {
            pitch_observations.push(observation);
            let reference_target = loaded_reference
                .as_ref()
                .and_then(|map| map.target_at(observation.sample_position));
            let decision = correction_planner.process_with_reference(observation, reference_target);
            current_correction_cents = decision.applied_correction_cents;
            correction_decisions.push(decision);
        }

        if inject_underrun {
            underrun_events += 1;
            dropped_frames += input.len() as u64;
        } else if inject_disconnect {
            if disconnect_events == 0 {
                disconnect_events = 1;
            }
            dropped_frames += input.len() as u64;
        } else if config.audio_transform_enabled {
            pitch_shifter.process_block(input, output, current_correction_cents);
            for sample in output.iter_mut() {
                *sample = (*sample * gain).clamp(-1.0, 1.0);
            }
        } else {
            for (destination, sample) in output.iter_mut().zip(input) {
                *destination = (*sample * gain).clamp(-1.0, 1.0);
            }
        }
        if let Some(dynamics) = &mut vocal_dynamics {
            let scratch = &mut dynamics_scratch[..output.len()];
            dynamics.process_block(output, scratch);
            output.copy_from_slice(scratch);
        }

        if config.fault == SimulationFault::CpuOverload && block_index > 0 && block_index % 50 == 0
        {
            std::thread::sleep(Duration::from_secs_f64(block_budget * 1.5));
        }
        let elapsed = started_at.elapsed().as_secs_f64() * 1_000.0;
        if elapsed > block_budget * 1_000.0 {
            deadline_misses += 1;
        }
        processing_ms.push(elapsed);
    }

    let raw_path = config.output_dir.join("raw.wav");
    let processed_path = config.output_dir.join("processed.wav");
    let metrics_path = config.output_dir.join("metrics.json");
    let pitch_path = config.output_dir.join("pitch.json");
    let correction_path = config.output_dir.join("correction.json");
    let generated_reference_path = config.output_dir.join("reference.json");
    let raw_rms_before = rms(&raw);
    let level_match_gain_db = if (config.audio_transform_enabled || config.vocal_dynamics_enabled)
        && config.fault == SimulationFault::None
    {
        let maximum = if config.vocal_dynamics_enabled {
            10.0_f32.powf(-1.0 / 20.0)
        } else {
            1.0
        };
        match_rms(raw_rms_before * gain, &mut processed, maximum)
    } else {
        0.0
    };
    write_float32_wav(&raw_path, &raw)?;
    write_float32_wav(&processed_path, &processed)?;

    let (processing_mean_ms, processing_max_ms, processing_p95_ms, processing_p99_ms) =
        processing_summary(&mut processing_ms);
    let (voiced_observations, f0_mean_hz, f0_min_hz, f0_max_hz, confidence_mean) =
        pitch_summary(&pitch_observations);
    let correction = correction_summary(&correction_decisions);
    let processed_pitch_observations = pitch_track(&processed)?;
    let (_, processed_f0_mean_hz, _, _, _) = pitch_summary(&processed_pitch_observations);
    let measured_pitch_shift_cents = f0_mean_hz
        .zip(processed_f0_mean_hz)
        .and_then(|(raw_hz, processed_hz)| crate::pitch::cents_between(processed_hz, raw_hz));
    let mean_processed_reference_error_cents = loaded_reference
        .as_ref()
        .and_then(|reference| mean_reference_error(&processed_pitch_observations, reference));
    let transform_metrics = pitch_shifter.metrics();
    let dynamics_metrics = vocal_dynamics
        .as_ref()
        .map(VocalDynamicsProcessor::metrics)
        .unwrap_or_default();
    let generated_reference = ReferenceVocalMap::build(
        source.clone(),
        config.block_frames,
        &pitch_observations,
        &ReferenceBuildConfig::default(),
    )?;
    generated_reference.save(&generated_reference_path)?;
    let report = SimulationReport {
        schema_version: 1,
        stage: if config.fault == SimulationFault::None && deadline_misses == 0 {
            "SIMULATION_PASSED".into()
        } else if config.fault != SimulationFault::None {
            "EXPECTED_FAULT_OBSERVED".into()
        } else {
            "SIMULATION_DEGRADED".into()
        },
        backend: "virtual_qu16_usb".into(),
        evidence_class: "simulation_only".into(),
        sample_rate: SAMPLE_RATE,
        internal_format: INTERNAL_FORMAT.into(),
        source,
        duration_seconds: raw.len() as f64 / SAMPLE_RATE as f64,
        block_frames: config.block_frames,
        blocks: raw.len().div_ceil(config.block_frames) as u64,
        frames: raw.len() as u64,
        gain_db: config.gain_db,
        fault: config.fault,
        simulated_input_buffer_ms: frames_to_ms(config.block_frames),
        simulated_output_buffer_ms: frames_to_ms(config.block_frames),
        simulated_transport_ms: frames_to_ms(config.block_frames * 2),
        round_trip_ms: None,
        round_trip_evidence:
            "not measured: virtual transport cannot prove Qu-16 USB or physical RTT".into(),
        processing_mean_ms,
        processing_max_ms,
        processing_p95_ms,
        processing_p99_ms,
        deadline_misses,
        underrun_events,
        dropped_frames,
        disconnect_events,
        nan_samples: processed
            .iter()
            .filter(|sample| !sample.is_finite())
            .count() as u64,
        raw_peak: peak(&raw),
        processed_peak: peak(&processed),
        pitch_observations: pitch_observations.len() as u64,
        voiced_observations,
        voiced_ratio: if pitch_observations.is_empty() {
            0.0
        } else {
            voiced_observations as f64 / pitch_observations.len() as f64
        },
        f0_mean_hz,
        f0_min_hz,
        f0_max_hz,
        confidence_mean,
        correction_observations: correction_decisions.len() as u64,
        active_correction_observations: correction.active,
        deadband_observations: correction.deadband,
        bypassed_correction_observations: correction.bypassed,
        mean_absolute_cents_error: correction.mean_absolute_error,
        mean_absolute_applied_cents: correction.mean_absolute_applied,
        maximum_absolute_applied_cents: correction.maximum_absolute_applied,
        chromatic_target_observations: correction.chromatic_targets,
        scale_target_observations: correction.scale_targets,
        reference_target_observations: correction.reference_targets,
        generated_reference_segments: generated_reference.segments.len() as u64,
        reference_input,
        audio_transform: if config.audio_transform_enabled {
            "lpc_residual_granular_v1".into()
        } else {
            "bypass".into()
        },
        formant_preservation: config.audio_transform_enabled,
        transform_algorithmic_latency_ms: if config.audio_transform_enabled {
            FormantPreservingPitchShifter::algorithmic_latency_ms()
        } else {
            0.0
        },
        transient_bypass_samples: transform_metrics.transient_bypass_samples,
        invalid_transform_fallback_samples: transform_metrics.invalid_fallback_samples,
        level_match_gain_db,
        raw_rms_dbfs: amplitude_to_dbfs(raw_rms_before),
        processed_rms_dbfs: amplitude_to_dbfs(rms(&processed)),
        processed_f0_mean_hz,
        measured_pitch_shift_cents,
        mean_processed_reference_error_cents,
        vocal_dynamics: if config.vocal_dynamics_enabled {
            "hpf_presence_deesser_compressor_limiter_v1".into()
        } else {
            "bypass".into()
        },
        dynamics_deesser_active_samples: dynamics_metrics.deesser_active_samples,
        dynamics_compressor_active_samples: dynamics_metrics.compressor_active_samples,
        dynamics_limiter_active_samples: dynamics_metrics.limiter_active_samples,
        maximum_deesser_reduction_db: dynamics_metrics.maximum_deesser_reduction_db,
        maximum_compressor_reduction_db: dynamics_metrics.maximum_compressor_reduction_db,
        maximum_limiter_reduction_db: dynamics_metrics.maximum_limiter_reduction_db,
        invalid_dynamics_fallback_samples: dynamics_metrics.invalid_fallback_samples,
        raw_wav: raw_path.display().to_string(),
        processed_wav: processed_path.display().to_string(),
        metrics_json: metrics_path.display().to_string(),
        pitch_json: pitch_path.display().to_string(),
        correction_json: correction_path.display().to_string(),
        generated_reference_json: generated_reference_path.display().to_string(),
    };
    let encoded_pitch = serde_json::to_vec_pretty(&pitch_observations)
        .map_err(|error| EngineError(format!("无法编码 F0 轨迹：{error}")))?;
    fs::write(&pitch_path, encoded_pitch)
        .map_err(|error| EngineError(format!("无法写入 F0 轨迹：{error}")))?;
    let encoded_correction = serde_json::to_vec_pretty(&correction_decisions)
        .map_err(|error| EngineError(format!("无法编码修正控制轨：{error}")))?;
    fs::write(&correction_path, encoded_correction)
        .map_err(|error| EngineError(format!("无法写入修正控制轨：{error}")))?;
    let encoded = serde_json::to_vec_pretty(&report)
        .map_err(|error| EngineError(format!("无法编码模拟指标：{error}")))?;
    fs::write(&metrics_path, encoded)
        .map_err(|error| EngineError(format!("无法写入模拟指标：{error}")))?;
    Ok(report)
}

fn validate(config: &SimulationConfig) -> Result<(), EngineError> {
    if !config.duration_seconds.is_finite() || config.duration_seconds <= 0.0 {
        return Err(EngineError("duration_seconds 必须是大于 0 的有限数".into()));
    }
    if config.block_frames == 0 || config.block_frames > 4096 {
        return Err(EngineError("block_frames 必须在 1..=4096".into()));
    }
    if !config.gain_db.is_finite() || !(-60.0..=12.0).contains(&config.gain_db) {
        return Err(EngineError("gain_db 必须在 -60..=12 dB".into()));
    }
    if !(0.0..=1.0).contains(&config.correction_strength)
        || !(0.0..=50.0).contains(&config.correction_deadband_cents)
        || !(1.0..=200.0).contains(&config.maximum_correction_cents)
    {
        return Err(EngineError("模拟修音控制参数无效".into()));
    }
    if config.key_tonic.is_some() != config.scale_mode.is_some()
        || config.key_tonic.is_some_and(|tonic| tonic > 11)
    {
        return Err(EngineError("--key 与 --scale 必须成对且主音有效".into()));
    }
    if !config.synthetic_detune_cents.is_finite()
        || !(-1_200.0..=1_200.0).contains(&config.synthetic_detune_cents)
    {
        return Err(EngineError("synthetic_detune_cents 必须在 ±1200".into()));
    }
    Ok(())
}

fn read_mono_float32_48k(path: &Path) -> Result<Vec<f32>, EngineError> {
    let mut reader = WavReader::open(path)
        .map_err(|error| EngineError(format!("无法读取 WAV {}：{error}", path.display())))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE {
        return Err(EngineError(format!(
            "WAV 必须是 48kHz，当前为 {}Hz；P0 禁止隐式重采样",
            spec.sample_rate
        )));
    }
    let channels = spec.channels as usize;
    if channels == 0 {
        return Err(EngineError("WAV 通道数不能为 0".into()));
    }
    let interleaved = match spec.sample_format {
        SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| EngineError(format!("无法解码 float WAV：{error}")))?,
        SampleFormat::Int if spec.bits_per_sample <= 16 => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| EngineError(format!("无法解码 PCM16 WAV：{error}")))?,
        SampleFormat::Int => {
            let scale = ((1_i64 << (spec.bits_per_sample - 1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| EngineError(format!("无法解码 PCM WAV：{error}")))?
        }
    };
    Ok(interleaved
        .into_iter()
        .step_by(channels)
        .map(|sample| sample.clamp(-1.0, 1.0))
        .collect())
}

fn synthetic_vocal(seconds: f64, detune_cents: f32) -> Vec<f32> {
    let frames = (seconds * SAMPLE_RATE as f64).round() as usize;
    let mut phase = 0.0_f32;
    let detune_ratio = 2.0_f32.powf(detune_cents / 1_200.0);
    (0..frames)
        .map(|index| {
            let time = index as f32 / SAMPLE_RATE as f32;
            let fundamental = (196.0 + 10.0 * (TAU * 4.8 * time).sin()) * detune_ratio;
            phase = (phase + TAU * fundamental / SAMPLE_RATE as f32) % TAU;
            let syllable = (0.58 + 0.42 * (TAU * 1.7 * time).sin()).max(0.0);
            let sample = phase.sin() + 0.34 * (2.0 * phase).sin() + 0.16 * (3.0 * phase).sin();
            (sample * syllable * 0.28).clamp(-1.0, 1.0)
        })
        .collect()
}

fn fit_duration(mut samples: Vec<f32>, frames: usize) -> Vec<f32> {
    samples.resize(frames, 0.0);
    samples.truncate(frames);
    samples
}

fn write_float32_wav(path: &Path, samples: &[f32]) -> Result<(), EngineError> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::create(path, spec)
        .map_err(|error| EngineError(format!("无法创建 WAV {}：{error}", path.display())))?;
    for sample in samples {
        writer
            .write_sample(*sample)
            .map_err(|error| EngineError(format!("无法写入 WAV：{error}")))?;
    }
    writer
        .finalize()
        .map_err(|error| EngineError(format!("无法完成 WAV：{error}")))
}

fn processing_summary(values: &mut [f64]) -> (f64, f64, f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    values.sort_by(f64::total_cmp);
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let max = *values.last().unwrap_or(&0.0);
    (
        mean,
        max,
        percentile(values, 0.95),
        percentile(values, 0.99),
    )
}

fn percentile(values: &[f64], value: f64) -> f64 {
    let index = ((values.len() as f64 * value).ceil() as usize)
        .saturating_sub(1)
        .min(values.len() - 1);
    values[index]
}

fn frames_to_ms(frames: usize) -> f64 {
    frames as f64 / SAMPLE_RATE as f64 * 1_000.0
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().copied().map(f32::abs).fold(0.0, f32::max)
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples
        .iter()
        .map(|sample| *sample as f64 * *sample as f64)
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt() as f32
}

fn amplitude_to_dbfs(amplitude: f32) -> f32 {
    20.0 * amplitude.max(1.0e-12).log10()
}

fn match_rms(target_rms: f32, samples: &mut [f32], maximum: f32) -> f32 {
    let current_rms = rms(samples);
    if target_rms <= 1.0e-9 || current_rms <= 1.0e-9 {
        return 0.0;
    }
    let requested_gain =
        (target_rms / current_rms).clamp(10.0_f32.powf(-3.0 / 20.0), 10.0_f32.powf(3.0 / 20.0));
    let peak_limited_gain = maximum / peak(samples).max(1.0e-12);
    let gain = requested_gain.min(peak_limited_gain);
    for sample in samples {
        *sample = (*sample * gain).clamp(-maximum, maximum);
    }
    20.0 * gain.log10()
}

fn pitch_track(samples: &[f32]) -> Result<Vec<PitchObservation>, EngineError> {
    let mut tracker = PitchTracker::new(PitchTrackerConfig::default())?;
    Ok(samples
        .chunks(128)
        .filter_map(|block| tracker.process_block(block))
        .collect())
}

fn mean_reference_error(
    observations: &[PitchObservation],
    reference: &ReferenceVocalMap,
) -> Option<f32> {
    let errors = observations
        .iter()
        .filter_map(|observation| {
            observation
                .f0_hz
                .zip(reference.target_at(observation.sample_position))
        })
        .filter_map(|(measured, target)| crate::pitch::cents_between(measured, target.target_hz))
        .map(f32::abs)
        .collect::<Vec<_>>();
    (!errors.is_empty()).then(|| errors.iter().sum::<f32>() / errors.len() as f32)
}

fn pitch_summary(
    observations: &[PitchObservation],
) -> (u64, Option<f32>, Option<f32>, Option<f32>, f32) {
    let voiced = observations
        .iter()
        .filter(|observation| observation.voiced)
        .collect::<Vec<_>>();
    if voiced.is_empty() {
        return (0, None, None, None, 0.0);
    }
    let frequencies = voiced
        .iter()
        .filter_map(|observation| observation.f0_hz)
        .collect::<Vec<_>>();
    let mean = frequencies.iter().sum::<f32>() / frequencies.len() as f32;
    let min = frequencies.iter().copied().reduce(f32::min);
    let max = frequencies.iter().copied().reduce(f32::max);
    let confidence = voiced
        .iter()
        .map(|observation| observation.confidence)
        .sum::<f32>()
        / voiced.len() as f32;
    (voiced.len() as u64, Some(mean), min, max, confidence)
}

struct CorrectionSummary {
    active: u64,
    deadband: u64,
    bypassed: u64,
    mean_absolute_error: f32,
    mean_absolute_applied: f32,
    maximum_absolute_applied: f32,
    chromatic_targets: u64,
    scale_targets: u64,
    reference_targets: u64,
}

fn correction_summary(decisions: &[CorrectionDecision]) -> CorrectionSummary {
    let active = decisions
        .iter()
        .filter(|decision| decision.state == CorrectionState::Active)
        .count() as u64;
    let deadband = decisions
        .iter()
        .filter(|decision| decision.state == CorrectionState::Deadband)
        .count() as u64;
    let bypassed = decisions.len() as u64 - active - deadband;
    let errors = decisions
        .iter()
        .filter_map(|decision| decision.cents_error)
        .map(f32::abs)
        .collect::<Vec<_>>();
    let mean_absolute_error = if errors.is_empty() {
        0.0
    } else {
        errors.iter().sum::<f32>() / errors.len() as f32
    };
    let mean_absolute_applied = if decisions.is_empty() {
        0.0
    } else {
        decisions
            .iter()
            .map(|decision| decision.applied_correction_cents.abs())
            .sum::<f32>()
            / decisions.len() as f32
    };
    let maximum_absolute_applied = decisions
        .iter()
        .map(|decision| decision.applied_correction_cents.abs())
        .fold(0.0, f32::max);
    let chromatic_targets = decisions
        .iter()
        .filter(|decision| decision.target_source == TargetSource::Chromatic)
        .count() as u64;
    let scale_targets = decisions
        .iter()
        .filter(|decision| decision.target_source == TargetSource::Scale)
        .count() as u64;
    let reference_targets = decisions
        .iter()
        .filter(|decision| decision.target_source == TargetSource::Reference)
        .count() as u64;
    CorrectionSummary {
        active,
        deadband,
        bypassed,
        mean_absolute_error,
        mean_absolute_applied,
        maximum_absolute_applied,
        chromatic_targets,
        scale_targets,
        reference_targets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("king-vocal-engine-{name}-{}", std::process::id()))
    }

    fn remove_evidence(directory: &Path) {
        for name in [
            "raw.wav",
            "processed.wav",
            "metrics.json",
            "pitch.json",
            "correction.json",
            "reference.json",
        ] {
            let _ = fs::remove_file(directory.join(name));
        }
        let _ = fs::remove_dir(directory);
    }

    #[test]
    fn virtual_qu16_produces_replayable_evidence() {
        let output_dir = test_directory("baseline");
        remove_evidence(&output_dir);
        let report = run_simulation(&SimulationConfig {
            output_dir: output_dir.clone(),
            duration_seconds: 0.05,
            ..SimulationConfig::default()
        })
        .expect("baseline simulation should pass");
        assert_eq!(report.stage, "SIMULATION_PASSED");
        assert_eq!(report.frames, 2400);
        assert_eq!(report.round_trip_ms, None);
        assert!(output_dir.join("raw.wav").is_file());
        assert!(output_dir.join("processed.wav").is_file());
        assert!(output_dir.join("metrics.json").is_file());
        assert!(output_dir.join("pitch.json").is_file());
        assert!(output_dir.join("correction.json").is_file());
        assert!(output_dir.join("reference.json").is_file());
        assert!(report.voiced_observations > 0);
        assert_eq!(report.correction_observations, report.pitch_observations);
        remove_evidence(&output_dir);
    }

    #[test]
    fn virtual_fault_is_observed_without_becoming_hardware_evidence() {
        let output_dir = test_directory("underrun");
        remove_evidence(&output_dir);
        let report = run_simulation(&SimulationConfig {
            output_dir: output_dir.clone(),
            duration_seconds: 0.2,
            block_frames: 64,
            fault: SimulationFault::Underrun,
            ..SimulationConfig::default()
        })
        .expect("fault simulation should complete");
        assert_eq!(report.stage, "EXPECTED_FAULT_OBSERVED");
        assert!(report.underrun_events > 0);
        assert!(report.dropped_frames > 0);
        assert_eq!(report.evidence_class, "simulation_only");
        remove_evidence(&output_dir);
    }

    #[test]
    fn second_pass_uses_reference_to_detect_a_full_semitone_error() {
        let ideal_dir = test_directory("reference-ideal");
        let singer_dir = test_directory("reference-singer");
        remove_evidence(&ideal_dir);
        remove_evidence(&singer_dir);
        let ideal = run_simulation(&SimulationConfig {
            output_dir: ideal_dir.clone(),
            duration_seconds: 0.2,
            ..SimulationConfig::default()
        })
        .expect("reference preparation should pass");
        assert!(ideal.generated_reference_segments > 0);
        let singer = run_simulation(&SimulationConfig {
            output_dir: singer_dir.clone(),
            duration_seconds: 0.2,
            synthetic_detune_cents: 100.0,
            reference_map: Some(ideal_dir.join("reference.json")),
            ..SimulationConfig::default()
        })
        .expect("reference guided singer pass should complete");
        assert!(singer.reference_target_observations > 0);
        assert!(singer.mean_absolute_cents_error > 70.0);
        assert!(singer
            .measured_pitch_shift_cents
            .is_some_and(|cents| cents < -15.0));
        assert_eq!(singer.invalid_transform_fallback_samples, 0);
        remove_evidence(&ideal_dir);
        remove_evidence(&singer_dir);
    }

    #[test]
    fn p8_dynamics_runs_inside_the_replayable_signal_path() {
        let output_dir = test_directory("p8-dynamics");
        remove_evidence(&output_dir);
        let report = run_simulation(&SimulationConfig {
            output_dir: output_dir.clone(),
            duration_seconds: 0.25,
            audio_transform_enabled: false,
            vocal_dynamics_enabled: true,
            ..SimulationConfig::default()
        })
        .expect("P8 dynamics simulation should pass");
        assert_eq!(
            report.vocal_dynamics,
            "hpf_presence_deesser_compressor_limiter_v1"
        );
        assert!(report.dynamics_compressor_active_samples > 0);
        assert_eq!(report.invalid_dynamics_fallback_samples, 0);
        assert!(report.processed_peak <= 10.0_f32.powf(-1.0 / 20.0) + 1.0e-6);
        remove_evidence(&output_dir);
    }
}
