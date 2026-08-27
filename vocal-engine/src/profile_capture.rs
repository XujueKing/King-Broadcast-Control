use crate::{EngineError, SAMPLE_RATE};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    BufferSize, SampleFormat, StreamConfig,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInputDevice {
    pub name: String,
    pub channels: usize,
    pub sample_rate: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCaptureReport {
    pub sample_rate: u32,
    pub channel: usize,
    pub duration_seconds: f32,
    pub peak_dbfs: f32,
    pub rms_dbfs: f32,
    pub clipping_ratio: f32,
    pub silence_ratio: f32,
    pub accepted: bool,
    pub message: String,
}

pub fn profile_input_devices() -> Result<Vec<ProfileInputDevice>, EngineError> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|error| EngineError(format!("input device enumeration failed: {error}")))?;
    let mut result = Vec::new();
    for device in devices {
        let name = device.to_string();
        if let Some(config) = select_config(&device) {
            result.push(ProfileInputDevice {
                name,
                channels: config.channels as usize,
                sample_rate: SAMPLE_RATE,
            });
        }
    }
    Ok(result)
}

pub fn record_profile_sample(
    device_name: &str,
    channel: usize,
    duration_seconds: u32,
    destination: &Path,
) -> Result<ProfileCaptureReport, EngineError> {
    if device_name.trim().is_empty() || !(8..=30).contains(&duration_seconds) {
        return Err(EngineError(
            "profile capture requires a device and 8-30 seconds".into(),
        ));
    }
    let host = cpal::default_host();
    let device = host
        .input_devices()
        .map_err(|error| EngineError(format!("input device enumeration failed: {error}")))?
        .find(|device| device.to_string() == device_name)
        .ok_or_else(|| EngineError(format!("input device not found: {device_name}")))?;
    let supported = select_config(&device)
        .ok_or_else(|| EngineError("device has no 48 kHz float32 input mode".into()))?;
    let channels = supported.channels as usize;
    if channel >= channels {
        return Err(EngineError(format!(
            "input channel {} is outside the device's {} channels",
            channel + 1,
            channels
        )));
    }
    let target_frames = SAMPLE_RATE as usize * duration_seconds as usize;
    let target_samples = target_frames * channels;
    let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(target_samples)));
    let captured = Arc::clone(&samples);
    let stream = device
        .build_input_stream(
            supported,
            move |data: &[f32], _| {
                if let Ok(mut output) = captured.try_lock() {
                    let remaining = target_samples.saturating_sub(output.len());
                    output.extend(
                        data.iter()
                            .take(remaining)
                            .map(|sample| sample.clamp(-1.0, 1.0)),
                    );
                }
            },
            move |error| eprintln!("vocal profile capture error: {error}"),
            None,
        )
        .map_err(|error| EngineError(format!("profile capture stream build failed: {error}")))?;
    stream
        .play()
        .map_err(|error| EngineError(format!("profile capture stream start failed: {error}")))?;
    thread::sleep(Duration::from_secs(duration_seconds as u64));
    drop(stream);
    let samples = samples
        .lock()
        .map_err(|_| EngineError("profile capture buffer lock failed".into()))?;
    let captured_frames = samples.len() / channels;
    if captured_frames < SAMPLE_RATE as usize * 2 {
        return Err(EngineError(
            "profile capture produced too little audio".into(),
        ));
    }
    let channel_samples = (0..channels)
        .map(|candidate| {
            samples
                .chunks_exact(channels)
                .map(|frame| frame[candidate])
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let preferred_rms = rms_amplitude(&channel_samples[channel]);
    let strongest_channel = channel_samples
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            rms_amplitude(left)
                .partial_cmp(&rms_amplitude(right))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(candidate, _)| candidate)
        .unwrap_or(channel);
    let strongest_rms = rms_amplitude(&channel_samples[strongest_channel]);
    let selected_channel = if strongest_channel != channel
        && amplitude_to_dbfs(preferred_rms) < -42.0
        && amplitude_to_dbfs(strongest_rms) >= amplitude_to_dbfs(preferred_rms) + 6.0
    {
        strongest_channel
    } else {
        channel
    };
    let samples = &channel_samples[selected_channel];
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| EngineError(format!("profile directory creation failed: {error}")))?;
    }
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(destination, spec)
        .map_err(|error| EngineError(format!("profile WAV creation failed: {error}")))?;
    for sample in samples.iter().copied() {
        writer
            .write_sample(sample)
            .map_err(|error| EngineError(format!("profile WAV write failed: {error}")))?;
    }
    writer
        .finalize()
        .map_err(|error| EngineError(format!("profile WAV finalize failed: {error}")))?;

    let peak = samples
        .iter()
        .fold(0.0_f32, |value, sample| value.max(sample.abs()));
    let rms = rms_amplitude(samples);
    let clipping_ratio = samples
        .iter()
        .filter(|sample| sample.abs() >= 0.985)
        .count() as f32
        / samples.len() as f32;
    let silence_ratio =
        samples.iter().filter(|sample| sample.abs() < 0.003).count() as f32 / samples.len() as f32;
    let peak_dbfs = amplitude_to_dbfs(peak);
    let rms_dbfs = amplitude_to_dbfs(rms);
    let accepted = (-30.0..=-1.0).contains(&peak_dbfs)
        && rms_dbfs >= -42.0
        && clipping_ratio <= 0.002
        && silence_ratio <= 0.72;
    let auto_channel_note = if selected_channel != channel {
        format!(
            "已自动从通道 {} 切换到有声音的通道 {}；",
            channel + 1,
            selected_channel + 1
        )
    } else {
        String::new()
    };
    let message = if accepted {
        format!("{auto_channel_note}样本合格，已保存为 48 kHz 单声道干声")
    } else if clipping_ratio > 0.002 || peak_dbfs > -1.0 {
        "样本削波，请降低输入增益后重录".to_string()
    } else if rms_dbfs < -42.0 || peak_dbfs < -30.0 {
        "样本太小，请靠近麦克风或提高输入增益后重录".to_string()
    } else {
        "有效演唱太短，请持续按提示演唱后重录".to_string()
    };
    Ok(ProfileCaptureReport {
        sample_rate: SAMPLE_RATE,
        channel: selected_channel,
        duration_seconds: samples.len() as f32 / SAMPLE_RATE as f32,
        peak_dbfs,
        rms_dbfs,
        clipping_ratio,
        silence_ratio,
        accepted,
        message,
    })
}

fn rms_amplitude(samples: &[f32]) -> f32 {
    let sum_squares = samples
        .iter()
        .map(|sample| (*sample as f64) * (*sample as f64))
        .sum::<f64>();
    (sum_squares / samples.len().max(1) as f64).sqrt() as f32
}

fn select_config(device: &cpal::Device) -> Option<StreamConfig> {
    device
        .supported_input_configs()
        .ok()?
        .find(|range| {
            range.sample_format() == SampleFormat::F32
                && range.min_sample_rate() <= SAMPLE_RATE
                && range.max_sample_rate() >= SAMPLE_RATE
        })
        .map(|range| StreamConfig {
            channels: range.channels(),
            sample_rate: SAMPLE_RATE,
            buffer_size: BufferSize::Default,
        })
}

fn amplitude_to_dbfs(amplitude: f32) -> f32 {
    if !amplitude.is_finite() || amplitude <= 0.000_001 {
        -120.0
    } else {
        (20.0 * amplitude.log10()).clamp(-120.0, 0.0)
    }
}
