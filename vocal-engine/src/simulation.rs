use crate::{EngineError, INTERNAL_FORMAT, SAMPLE_RATE};
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
    pub raw_wav: String,
    pub processed_wav: String,
    pub metrics_json: String,
}

pub fn run_simulation(config: &SimulationConfig) -> Result<SimulationReport, EngineError> {
    validate(config)?;
    fs::create_dir_all(&config.output_dir)
        .map_err(|error| EngineError(format!("无法创建模拟证据目录：{error}")))?;

    let (source, raw) = match &config.input_wav {
        Some(path) => (path.display().to_string(), read_mono_float32_48k(path)?),
        None => (
            "synthetic_vocal_like_signal".into(),
            synthetic_vocal(config.duration_seconds),
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

        if inject_underrun {
            underrun_events += 1;
            dropped_frames += input.len() as u64;
        } else if inject_disconnect {
            if disconnect_events == 0 {
                disconnect_events = 1;
            }
            dropped_frames += input.len() as u64;
        } else {
            for (destination, sample) in output.iter_mut().zip(input) {
                *destination = (*sample * gain).clamp(-1.0, 1.0);
            }
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
    write_float32_wav(&raw_path, &raw)?;
    write_float32_wav(&processed_path, &processed)?;

    let (processing_mean_ms, processing_max_ms, processing_p95_ms, processing_p99_ms) =
        processing_summary(&mut processing_ms);
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
        raw_wav: raw_path.display().to_string(),
        processed_wav: processed_path.display().to_string(),
        metrics_json: metrics_path.display().to_string(),
    };
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

fn synthetic_vocal(seconds: f64) -> Vec<f32> {
    let frames = (seconds * SAMPLE_RATE as f64).round() as usize;
    let mut phase = 0.0_f32;
    (0..frames)
        .map(|index| {
            let time = index as f32 / SAMPLE_RATE as f32;
            let fundamental = 196.0 + 10.0 * (TAU * 4.8 * time).sin();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("king-vocal-engine-{name}-{}", std::process::id()))
    }

    fn remove_evidence(directory: &Path) {
        for name in ["raw.wav", "processed.wav", "metrics.json"] {
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
}
