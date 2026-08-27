use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    BufferSize, Device, SampleFormat, Stream, StreamConfig, SupportedBufferSize,
    SupportedStreamConfig,
};
use rtrb::RingBuffer;
use serde::Serialize;
use std::{
    array,
    error::Error,
    fmt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub mod blend;
pub mod calibration;
pub mod capture;
pub mod clock_drift;
pub mod control;
pub mod correction;
pub mod desktop_bridge;
pub mod drift_runtime;
pub mod dynamics;
pub mod failover;
pub mod formant;
pub mod joint;
pub mod live_joint;
pub mod multilane;
pub mod output_gate;
pub mod pitch;
pub mod playback_clock;
pub mod preset;
pub mod profile_capture;
pub mod qu16_meter;
pub mod quality;
pub mod reference;
pub mod rescue;
pub mod routing;
pub mod simulation;
pub mod site;

pub const SAMPLE_RATE: u32 = 48_000;
pub const INTERNAL_FORMAT: &str = "float32";
const HISTOGRAM_BUCKET_US: u64 = 50;
const HISTOGRAM_BUCKETS: usize = 202;

#[derive(Debug)]
pub struct EngineError(String);

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for EngineError {}

#[derive(Clone, Debug)]
pub struct LoopbackConfig {
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    pub input_channel: usize,
    pub output_channel: usize,
    pub buffer_frames: u32,
    pub ring_capacity_frames: usize,
    pub prefill_frames: usize,
    pub gain_db: f32,
    pub pitch_correction_enabled: bool,
    pub correction_strength: f32,
    pub correction_deadband_cents: f32,
    pub maximum_correction_cents: f32,
    pub key_tonic: Option<u8>,
    pub scale_mode: Option<correction::ScaleMode>,
    pub reference_map: Option<PathBuf>,
    pub reference_rescue_enabled: bool,
    pub reference_vocal_path: Option<PathBuf>,
    pub reference_rescue_gain_db: f32,
    pub reference_start_delay_ms: f32,
    pub vocal_dynamics_enabled: bool,
    pub vocal_quality_enabled: bool,
    pub adaptive_vocal_blend_enabled: bool,
    pub vocal_preset: preset::VocalPreset,
}

impl Default for LoopbackConfig {
    fn default() -> Self {
        Self {
            input_device: None,
            output_device: None,
            input_channel: 0,
            output_channel: 0,
            buffer_frames: 128,
            ring_capacity_frames: 4096,
            prefill_frames: 256,
            gain_db: -18.0,
            pitch_correction_enabled: false,
            correction_strength: 0.75,
            correction_deadband_cents: 8.0,
            maximum_correction_cents: 45.0,
            key_tonic: None,
            scale_mode: None,
            reference_map: None,
            reference_rescue_enabled: false,
            reference_vocal_path: None,
            reference_rescue_gain_db: 0.0,
            reference_start_delay_ms: 0.0,
            vocal_dynamics_enabled: false,
            vocal_quality_enabled: false,
            adaptive_vocal_blend_enabled: false,
            vocal_preset: preset::VocalPreset::Professional,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceCapability {
    pub name: String,
    pub is_default: bool,
    pub supports_48k_float32: bool,
    pub channels_48k_float32: Vec<u16>,
    pub buffer_size: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInventory {
    pub host: String,
    pub input_devices: Vec<AudioDeviceCapability>,
    pub output_devices: Vec<AudioDeviceCapability>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyMetrics {
    pub schema_version: u32,
    pub status: String,
    pub sample_rate: u32,
    pub internal_format: String,
    pub input_device: String,
    pub output_device: String,
    pub input_channels: u16,
    pub output_channels: u16,
    pub input_channel: usize,
    pub output_channel: usize,
    pub buffer_frames_requested: u32,
    pub input_buffer_frames_configured: u32,
    pub output_buffer_frames_configured: u32,
    pub input_buffer_ms: f64,
    pub processing_ms: f64,
    pub output_buffer_ms: f64,
    pub queue_delay_ms: f64,
    pub estimated_software_path_ms: f64,
    pub pitch_correction_enabled: bool,
    pub transform_algorithmic_latency_ms: f64,
    pub pitch_analysis_window_ms: f64,
    pub vocal_dynamics_enabled: bool,
    pub vocal_quality_enabled: bool,
    pub quality_score_latest: Option<f32>,
    pub quality_class_latest: Option<quality::VocalQualityClass>,
    pub adaptive_vocal_blend_enabled: bool,
    pub corrected_mix_latest: Option<f32>,
    pub reference_rescue_enabled: bool,
    pub reference_rescue_mix_latest: Option<f32>,
    pub reference_rescue_active: bool,
    pub round_trip_ms: Option<f64>,
    pub round_trip_evidence: String,
    pub xruns: u64,
    pub underrun_events: u64,
    pub overflow_events: u64,
    pub dropped_frames: u64,
    pub stream_errors: u64,
    pub max_processing_ms: f64,
    pub p95_processing_ms: f64,
    pub p99_processing_ms: f64,
    pub input_callbacks: u64,
    pub output_callbacks: u64,
    pub input_frames: u64,
    pub output_frames: u64,
}

pub struct RunningLoopback {
    _input_stream: Stream,
    _output_stream: Stream,
    metrics: Arc<AtomicMetrics>,
    descriptor: EngineDescriptor,
    preset_control: preset::VocalPresetControl,
    playback_clock: playback_clock::PlaybackClockControl,
    reference_rescue_control: Arc<AtomicBool>,
}

#[derive(Clone)]
struct EngineDescriptor {
    input_device: String,
    output_device: String,
    input_channels: u16,
    output_channels: u16,
    input_channel: usize,
    output_channel: usize,
    buffer_frames_requested: u32,
    input_buffer_frames_configured: u32,
    output_buffer_frames_configured: u32,
    pitch_correction_enabled: bool,
    transform_algorithmic_latency_ms: f64,
    pitch_analysis_window_ms: f64,
    vocal_dynamics_enabled: bool,
    vocal_quality_enabled: bool,
    adaptive_vocal_blend_enabled: bool,
    reference_rescue_enabled: bool,
}

pub(crate) struct LiveVocalProcessor {
    tracker: pitch::PitchTracker,
    planner: correction::CorrectionPlanner,
    shifter: formant::FormantPreservingPitchShifter,
    reference: Option<reference::ReferenceVocalMap>,
    correction_cents: f32,
    pitch_enabled: bool,
    dynamics: Option<dynamics::VocalDynamicsProcessor>,
    quality_enabled: bool,
    quality_scorer: quality::VocalQualityScorer,
    adaptive_blender: Option<blend::AdaptiveVocalBlender>,
    dry_delay: Option<blend::FixedDryDelay>,
    reference_rescue: Option<rescue::ReferenceVocalRescue>,
    reference_rescue_control: Arc<AtomicBool>,
    playback_clock: playback_clock::PlaybackClockReceiver,
    samples_processed: u64,
    preset_smoother: preset::VocalPresetSmoother,
    latest_quality_score: f32,
    maximum_correction_cents: f32,
}

impl LiveVocalProcessor {
    pub(crate) fn new(
        config: &LoopbackConfig,
        preset_receiver: preset::VocalPresetReceiver,
    ) -> Result<Self, EngineError> {
        let clock = playback_clock::PlaybackClockControl::new();
        Self::new_with_playback_clock(
            config,
            preset_receiver,
            clock.receiver(),
            Arc::new(AtomicBool::new(config.reference_rescue_enabled)),
        )
    }

    pub(crate) fn new_with_playback_clock(
        config: &LoopbackConfig,
        preset_receiver: preset::VocalPresetReceiver,
        playback_clock: playback_clock::PlaybackClockReceiver,
        reference_rescue_control: Arc<AtomicBool>,
    ) -> Result<Self, EngineError> {
        if config.key_tonic.is_some() != config.scale_mode.is_some() {
            return Err(EngineError("--key 与 --scale 必须同时提供".into()));
        }
        if config.adaptive_vocal_blend_enabled && !config.pitch_correction_enabled {
            return Err(EngineError(
                "Adaptive Vocal Blend 需要同时启用 Pitch Correction".into(),
            ));
        }
        if config.reference_rescue_enabled
            && (config.reference_map.is_none() || config.reference_vocal_path.is_none())
        {
            return Err(EngineError(
                "参考人声救援需要同时提供 --reference 和 --reference-vocal".into(),
            ));
        }
        let pitch_config = pitch::PitchTrackerConfig::default();
        let mut planner_config = correction::CorrectionPlannerConfig {
            strength: config.correction_strength,
            deadband_cents: config.correction_deadband_cents,
            maximum_correction_cents: config.maximum_correction_cents,
            ..correction::CorrectionPlannerConfig::default()
        };
        if let (Some(tonic), Some(mode)) = (config.key_tonic, config.scale_mode) {
            planner_config.allowed_pitch_classes = correction::scale_mask(tonic, mode);
        }
        let quality_enabled = config.vocal_quality_enabled
            || config.pitch_correction_enabled
            || config.reference_rescue_enabled;
        let reference = if config.pitch_correction_enabled || quality_enabled {
            config
                .reference_map
                .as_deref()
                .map(reference::ReferenceVocalMap::load)
                .transpose()?
        } else {
            None
        };
        let reference_rescue = if config.reference_rescue_enabled {
            Some(rescue::ReferenceVocalRescue::load(
                config
                    .reference_vocal_path
                    .as_deref()
                    .expect("validated above"),
                rescue::ReferenceRescueConfig {
                    reference_gain_db: config.reference_rescue_gain_db,
                    start_delay_ms: config.reference_start_delay_ms,
                    ..rescue::ReferenceRescueConfig::default()
                },
            )?)
        } else {
            None
        };
        Ok(Self {
            tracker: pitch::PitchTracker::new(pitch_config)?,
            planner: correction::CorrectionPlanner::new(planner_config)?,
            shifter: formant::FormantPreservingPitchShifter::new(formant::FormantShifterConfig {
                maximum_correction_cents: config.maximum_correction_cents,
                ..formant::FormantShifterConfig::default()
            })?,
            reference,
            correction_cents: 0.0,
            pitch_enabled: config.pitch_correction_enabled,
            dynamics: config
                .vocal_dynamics_enabled
                .then(|| {
                    dynamics::VocalDynamicsProcessor::new(dynamics::VocalDynamicsConfig::default())
                })
                .transpose()?,
            quality_enabled,
            quality_scorer: quality::VocalQualityScorer::new(
                quality::VocalQualityConfig::default(),
            )?,
            adaptive_blender: config
                .adaptive_vocal_blend_enabled
                .then(|| {
                    blend::AdaptiveVocalBlender::new(blend::AdaptiveVocalBlendConfig::default())
                })
                .transpose()?,
            dry_delay: config
                .adaptive_vocal_blend_enabled
                .then(|| {
                    blend::FixedDryDelay::new(
                        formant::FormantPreservingPitchShifter::algorithmic_latency_frames(),
                    )
                })
                .transpose()?,
            reference_rescue,
            reference_rescue_control,
            playback_clock,
            samples_processed: 0,
            preset_smoother: preset::VocalPresetSmoother::with_default_morph(preset_receiver)?,
            latest_quality_score: 100.0,
            maximum_correction_cents: config.maximum_correction_cents,
        })
    }

    pub(crate) fn process_sample(
        &mut self,
        sample: f32,
    ) -> (
        f32,
        Option<quality::VocalQualityObservation>,
        Option<f32>,
        Option<f32>,
    ) {
        let fallback_position = self.samples_processed;
        self.samples_processed = self.samples_processed.saturating_add(1);
        let playback = self.playback_clock.next(fallback_position);
        let sample_position = playback.position;
        let preset = self
            .preset_smoother
            .process_sample(self.latest_quality_score);
        self.planner.set_runtime_controls(
            preset.correction_strength,
            preset.deadband_cents,
            self.maximum_correction_cents * preset.maximum_correction_scale,
        );
        if let Some(blender) = &mut self.adaptive_blender {
            blender.set_corrected_mix_scale(preset.corrected_mix_scale);
            blender.set_quality_score(self.latest_quality_score);
        }
        if let Some(dynamics) = &mut self.dynamics {
            dynamics.set_wet_mix(preset.dynamics_scale);
        }
        let input = [sample];
        let mut quality_update = None;
        if self.pitch_enabled || self.quality_enabled {
            if let Some(observation) = self.tracker.process_block(&input) {
                let target = self.reference.as_ref().and_then(|map| {
                    playback
                        .playing
                        .then(|| map.target_at(sample_position))
                        .flatten()
                });
                if self.quality_enabled {
                    quality_update = Some(self.quality_scorer.process(
                        observation,
                        target,
                        self.reference.is_some(),
                    ));
                    if let (Some(blender), Some(quality)) =
                        (&mut self.adaptive_blender, quality_update)
                    {
                        blender.set_quality_score(quality.quality_score);
                    }
                    if let Some(quality) = quality_update {
                        self.latest_quality_score = quality.quality_score;
                    }
                }
                if self.pitch_enabled {
                    self.correction_cents = self
                        .planner
                        .process_with_reference(observation, target)
                        .applied_correction_cents;
                }
            }
        }
        let mut shifted = input;
        if self.pitch_enabled {
            self.shifter
                .process_block(&input, &mut shifted, self.correction_cents);
        }
        let routed = match (&mut self.adaptive_blender, &mut self.dry_delay) {
            (Some(blender), Some(dry_delay)) => {
                blender.process_sample(dry_delay.process_sample(sample), shifted[0])
            }
            _ => shifted[0],
        };
        let mut processed = [routed];
        if let Some(dynamics) = &mut self.dynamics {
            dynamics.process_block(&[routed], &mut processed);
        }
        let rescue_frame = self.reference_rescue.as_mut().map(|rescue| {
            let expected = self
                .reference
                .as_ref()
                .and_then(|map| map.target_at(sample_position))
                .is_some();
            rescue.process_sample(
                processed[0],
                expected,
                self.latest_quality_score,
                sample_position,
                playback.playing && self.reference_rescue_control.load(Ordering::Relaxed),
            )
        });
        (
            rescue_frame.map_or(processed[0], |frame| frame.sample),
            quality_update,
            self.adaptive_blender
                .as_ref()
                .map(blend::AdaptiveVocalBlender::corrected_mix),
            rescue_frame.map(|frame| frame.mix),
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferBenchmark {
    pub sample_rate: u32,
    pub block_frames: usize,
    pub blocks: u64,
    pub transferred_frames: u64,
    pub elapsed_ms: f64,
    pub mean_processing_ms_per_block: f64,
    pub realtime_budget_percent: f64,
    pub checksum: f64,
    pub scope: String,
}

struct AtomicMetrics {
    input_callbacks: AtomicU64,
    output_callbacks: AtomicU64,
    input_frames: AtomicU64,
    output_frames: AtomicU64,
    input_max_frames: AtomicU64,
    output_max_frames: AtomicU64,
    processing_total_ns: AtomicU64,
    processing_count: AtomicU64,
    processing_max_ns: AtomicU64,
    processing_histogram: [AtomicU64; HISTOGRAM_BUCKETS],
    queue_depth_total: AtomicU64,
    queue_depth_count: AtomicU64,
    underrun_events: AtomicU64,
    overflow_events: AtomicU64,
    dropped_frames: AtomicU64,
    stream_errors: AtomicU64,
    quality_updates: AtomicU64,
    quality_score_milli: AtomicU64,
    quality_class: AtomicU64,
    corrected_mix_milli: AtomicU64,
    reference_rescue_mix_milli: AtomicU64,
}

impl AtomicMetrics {
    fn new() -> Self {
        Self {
            input_callbacks: AtomicU64::new(0),
            output_callbacks: AtomicU64::new(0),
            input_frames: AtomicU64::new(0),
            output_frames: AtomicU64::new(0),
            input_max_frames: AtomicU64::new(0),
            output_max_frames: AtomicU64::new(0),
            processing_total_ns: AtomicU64::new(0),
            processing_count: AtomicU64::new(0),
            processing_max_ns: AtomicU64::new(0),
            processing_histogram: array::from_fn(|_| AtomicU64::new(0)),
            queue_depth_total: AtomicU64::new(0),
            queue_depth_count: AtomicU64::new(0),
            underrun_events: AtomicU64::new(0),
            overflow_events: AtomicU64::new(0),
            dropped_frames: AtomicU64::new(0),
            stream_errors: AtomicU64::new(0),
            quality_updates: AtomicU64::new(0),
            quality_score_milli: AtomicU64::new(0),
            quality_class: AtomicU64::new(quality::VocalQualityClass::RepairCandidate.code()),
            corrected_mix_milli: AtomicU64::new(0),
            reference_rescue_mix_milli: AtomicU64::new(0),
        }
    }

    fn observe_processing(&self, elapsed: Duration) {
        let nanos = elapsed.as_nanos().min(u64::MAX as u128) as u64;
        self.processing_total_ns.fetch_add(nanos, Ordering::Relaxed);
        self.processing_count.fetch_add(1, Ordering::Relaxed);
        self.processing_max_ns.fetch_max(nanos, Ordering::Relaxed);
        let micros = nanos / 1_000;
        let bucket = ((micros / HISTOGRAM_BUCKET_US) as usize).min(HISTOGRAM_BUCKETS - 1);
        self.processing_histogram[bucket].fetch_add(1, Ordering::Relaxed);
    }

    fn percentile_ms(&self, percentile: f64) -> f64 {
        let total = self.processing_count.load(Ordering::Relaxed);
        if total == 0 {
            return 0.0;
        }
        let target = ((total as f64 * percentile).ceil() as u64).max(1);
        let mut cumulative = 0;
        for (index, count) in self.processing_histogram.iter().enumerate() {
            cumulative += count.load(Ordering::Relaxed);
            if cumulative >= target {
                return index as f64 * HISTOGRAM_BUCKET_US as f64 / 1_000.0;
            }
        }
        (HISTOGRAM_BUCKETS - 1) as f64 * HISTOGRAM_BUCKET_US as f64 / 1_000.0
    }
}

pub fn enumerate_devices() -> Result<AudioDeviceInventory, EngineError> {
    let host = cpal::default_host();
    let default_input = host.default_input_device().map(|device| device.to_string());
    let default_output = host
        .default_output_device()
        .map(|device| device.to_string());
    let input_devices = host
        .input_devices()
        .map_err(|error| EngineError(format!("无法枚举输入设备：{error}")))?
        .filter_map(|device| describe_device(&device, default_input.as_deref(), true).ok())
        .collect();
    let output_devices = host
        .output_devices()
        .map_err(|error| EngineError(format!("无法枚举输出设备：{error}")))?
        .filter_map(|device| describe_device(&device, default_output.as_deref(), false).ok())
        .collect();
    Ok(AudioDeviceInventory {
        host: format!("{:?}", host.id()),
        input_devices,
        output_devices,
    })
}

fn describe_device(
    device: &Device,
    default_name: Option<&str>,
    input: bool,
) -> Result<AudioDeviceCapability, EngineError> {
    let name = device.to_string();
    let configs = if input {
        device
            .supported_input_configs()
            .map_err(|error| EngineError(format!("无法读取 {name} 输入能力：{error}")))?
            .collect::<Vec<_>>()
    } else {
        device
            .supported_output_configs()
            .map_err(|error| EngineError(format!("无法读取 {name} 输出能力：{error}")))?
            .collect::<Vec<_>>()
    };
    let mut channels = configs
        .iter()
        .filter(|config| {
            config.sample_format() == SampleFormat::F32
                && config.min_sample_rate() <= SAMPLE_RATE
                && config.max_sample_rate() >= SAMPLE_RATE
        })
        .map(|config| config.channels())
        .collect::<Vec<_>>();
    channels.sort_unstable();
    channels.dedup();
    let buffer_size = configs
        .iter()
        .find(|config| {
            config.sample_format() == SampleFormat::F32
                && config.min_sample_rate() <= SAMPLE_RATE
                && config.max_sample_rate() >= SAMPLE_RATE
        })
        .map(|config| format_buffer_size(config.buffer_size()))
        .unwrap_or_else(|| "unsupported".into());
    Ok(AudioDeviceCapability {
        is_default: default_name == Some(name.as_str()),
        supports_48k_float32: !channels.is_empty(),
        channels_48k_float32: channels,
        buffer_size,
        name,
    })
}

fn format_buffer_size(value: &SupportedBufferSize) -> String {
    match value {
        SupportedBufferSize::Range { min, max } => format!("{min}-{max} frames"),
        SupportedBufferSize::Unknown => "driver-managed".into(),
    }
}

pub fn start_loopback(config: &LoopbackConfig) -> Result<RunningLoopback, EngineError> {
    if config.buffer_frames == 0 {
        return Err(EngineError("buffer_frames 必须大于 0".into()));
    }
    if config.ring_capacity_frames <= config.prefill_frames {
        return Err(EngineError(
            "ring_capacity_frames 必须大于 prefill_frames".into(),
        ));
    }
    let host = cpal::default_host();
    let input_device = select_device(&host, config.input_device.as_deref(), true)?;
    let output_device = select_device(&host, config.output_device.as_deref(), false)?;
    let input_name = input_device.to_string();
    let output_name = output_device.to_string();
    let input_supported = select_float32_config(&input_device, config.input_channel, true)?;
    let output_supported = select_float32_config(&output_device, config.output_channel, false)?;
    let input_channels = input_supported.channels();
    let output_channels = output_supported.channels();
    let input_buffer_frames =
        resolve_buffer_frames(input_supported.buffer_size(), config.buffer_frames);
    let output_buffer_frames =
        resolve_buffer_frames(output_supported.buffer_size(), config.buffer_frames);
    let input_stream_config = stream_config(&input_supported, input_buffer_frames);
    let output_stream_config = stream_config(&output_supported, output_buffer_frames);
    let metrics = Arc::new(AtomicMetrics::new());
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(config.ring_capacity_frames);
    for _ in 0..config.prefill_frames {
        producer
            .push(0.0)
            .map_err(|_| EngineError("无法预填充实时环形缓冲区".into()))?;
    }

    let preset_control = preset::VocalPresetControl::new(config.vocal_preset);
    let playback_clock = playback_clock::PlaybackClockControl::new();
    let reference_rescue_control = Arc::new(AtomicBool::new(config.reference_rescue_enabled));
    let mut live_pitch = (config.pitch_correction_enabled
        || config.vocal_dynamics_enabled
        || config.vocal_quality_enabled
        || config.reference_rescue_enabled)
        .then(|| {
            LiveVocalProcessor::new_with_playback_clock(
                config,
                preset_control.receiver(),
                playback_clock.receiver(),
                Arc::clone(&reference_rescue_control),
            )
        })
        .transpose()?;

    let input_metrics = Arc::clone(&metrics);
    let input_error_metrics = Arc::clone(&metrics);
    let input_channel = config.input_channel;
    let input_stream = input_device
        .build_input_stream(
            input_stream_config,
            move |data: &[f32], _| {
                let started_at = Instant::now();
                let frames = data.len() / input_channels as usize;
                let mut dropped = 0u64;
                for frame in data.chunks_exact(input_channels as usize) {
                    let input = frame[input_channel];
                    let (routed, quality_update, corrected_mix, reference_rescue_mix) = live_pitch
                        .as_mut()
                        .map_or((input, None, None, None), |processor| {
                            processor.process_sample(input)
                        });
                    if let Some(quality) = quality_update {
                        input_metrics.quality_score_milli.store(
                            (quality.quality_score * 1_000.0).round() as u64,
                            Ordering::Relaxed,
                        );
                        input_metrics
                            .quality_class
                            .store(quality.quality_class.code(), Ordering::Relaxed);
                        input_metrics
                            .quality_updates
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    if let Some(corrected_mix) = corrected_mix {
                        input_metrics
                            .corrected_mix_milli
                            .store((corrected_mix * 1_000.0).round() as u64, Ordering::Relaxed);
                    }
                    if let Some(reference_rescue_mix) = reference_rescue_mix {
                        input_metrics.reference_rescue_mix_milli.store(
                            (reference_rescue_mix * 1_000.0).round() as u64,
                            Ordering::Relaxed,
                        );
                    }
                    if producer.push(routed).is_err() {
                        dropped += 1;
                    }
                }
                input_metrics
                    .input_callbacks
                    .fetch_add(1, Ordering::Relaxed);
                input_metrics
                    .input_frames
                    .fetch_add(frames as u64, Ordering::Relaxed);
                input_metrics
                    .input_max_frames
                    .fetch_max(frames as u64, Ordering::Relaxed);
                if dropped > 0 {
                    input_metrics
                        .overflow_events
                        .fetch_add(1, Ordering::Relaxed);
                    input_metrics
                        .dropped_frames
                        .fetch_add(dropped, Ordering::Relaxed);
                }
                input_metrics.observe_processing(started_at.elapsed());
            },
            move |_| {
                input_error_metrics
                    .stream_errors
                    .fetch_add(1, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|error| EngineError(format!("无法建立输入流 {input_name}：{error}")))?;

    let output_metrics = Arc::clone(&metrics);
    let output_error_metrics = Arc::clone(&metrics);
    let output_channel = config.output_channel;
    let gain = 10.0_f32.powf(config.gain_db / 20.0);
    let output_stream = output_device
        .build_output_stream(
            output_stream_config,
            move |data: &mut [f32], _| {
                let started_at = Instant::now();
                let frames = data.len() / output_channels as usize;
                let queue_depth = consumer.slots() as u64;
                let mut underrun = false;
                for frame in data.chunks_exact_mut(output_channels as usize) {
                    frame.fill(0.0);
                    match consumer.pop() {
                        Ok(sample) => frame[output_channel] = (sample * gain).clamp(-1.0, 1.0),
                        Err(_) => underrun = true,
                    }
                }
                output_metrics
                    .output_callbacks
                    .fetch_add(1, Ordering::Relaxed);
                output_metrics
                    .output_frames
                    .fetch_add(frames as u64, Ordering::Relaxed);
                output_metrics
                    .output_max_frames
                    .fetch_max(frames as u64, Ordering::Relaxed);
                output_metrics
                    .queue_depth_total
                    .fetch_add(queue_depth, Ordering::Relaxed);
                output_metrics
                    .queue_depth_count
                    .fetch_add(1, Ordering::Relaxed);
                if underrun {
                    output_metrics
                        .underrun_events
                        .fetch_add(1, Ordering::Relaxed);
                }
                output_metrics.observe_processing(started_at.elapsed());
            },
            move |_| {
                output_error_metrics
                    .stream_errors
                    .fetch_add(1, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|error| EngineError(format!("无法建立输出流 {output_name}：{error}")))?;

    input_stream
        .play()
        .map_err(|error| EngineError(format!("无法启动输入流：{error}")))?;
    output_stream
        .play()
        .map_err(|error| EngineError(format!("无法启动输出流：{error}")))?;
    Ok(RunningLoopback {
        _input_stream: input_stream,
        _output_stream: output_stream,
        metrics,
        preset_control,
        playback_clock,
        reference_rescue_control,
        descriptor: EngineDescriptor {
            input_device: input_name,
            output_device: output_name,
            input_channels,
            output_channels,
            input_channel: config.input_channel,
            output_channel: config.output_channel,
            buffer_frames_requested: config.buffer_frames,
            input_buffer_frames_configured: input_buffer_frames,
            output_buffer_frames_configured: output_buffer_frames,
            pitch_correction_enabled: config.pitch_correction_enabled,
            transform_algorithmic_latency_ms: if config.pitch_correction_enabled {
                formant::FormantPreservingPitchShifter::algorithmic_latency_ms() as f64
            } else {
                0.0
            },
            pitch_analysis_window_ms: if config.pitch_correction_enabled {
                pitch::PitchTrackerConfig::default().window_frames as f64 / SAMPLE_RATE as f64
                    * 1_000.0
            } else {
                0.0
            },
            vocal_dynamics_enabled: config.vocal_dynamics_enabled,
            vocal_quality_enabled: config.vocal_quality_enabled || config.pitch_correction_enabled,
            adaptive_vocal_blend_enabled: config.adaptive_vocal_blend_enabled,
            reference_rescue_enabled: config.reference_rescue_enabled,
        },
    })
}

fn resolve_buffer_frames(supported: &SupportedBufferSize, requested: u32) -> u32 {
    match supported {
        SupportedBufferSize::Range { min, max } => requested.clamp(*min, *max),
        SupportedBufferSize::Unknown => requested,
    }
}

fn select_device(
    host: &cpal::Host,
    requested: Option<&str>,
    input: bool,
) -> Result<Device, EngineError> {
    if let Some(requested) = requested {
        let mut devices = if input {
            host.input_devices()
        } else {
            host.output_devices()
        }
        .map_err(|error| EngineError(format!("无法枚举设备：{error}")))?;
        return devices
            .find(|device| device.to_string() == requested)
            .ok_or_else(|| EngineError(format!("找不到音频设备：{requested}")));
    }
    let device = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    device.ok_or_else(|| {
        EngineError(format!(
            "没有默认{}设备",
            if input { "输入" } else { "输出" }
        ))
    })
}

fn select_float32_config(
    device: &Device,
    channel_index: usize,
    input: bool,
) -> Result<SupportedStreamConfig, EngineError> {
    let name = device.to_string();
    let configs = if input {
        device
            .supported_input_configs()
            .map_err(|error| EngineError(format!("无法读取 {name} 输入配置：{error}")))?
            .collect::<Vec<_>>()
    } else {
        device
            .supported_output_configs()
            .map_err(|error| EngineError(format!("无法读取 {name} 输出配置：{error}")))?
            .collect::<Vec<_>>()
    };
    configs
        .into_iter()
        .filter(|candidate| {
            candidate.sample_format() == SampleFormat::F32
                && candidate.min_sample_rate() <= SAMPLE_RATE
                && candidate.max_sample_rate() >= SAMPLE_RATE
                && candidate.channels() as usize > channel_index
        })
        .min_by_key(|candidate| candidate.channels())
        .map(|candidate| candidate.with_sample_rate(SAMPLE_RATE))
        .ok_or_else(|| {
            EngineError(format!(
                "{name} 不支持 48kHz float32 或通道索引 {channel_index}"
            ))
        })
}

fn stream_config(supported: &SupportedStreamConfig, buffer_frames: u32) -> StreamConfig {
    StreamConfig {
        channels: supported.channels(),
        sample_rate: SAMPLE_RATE,
        buffer_size: BufferSize::Fixed(buffer_frames),
    }
}

impl RunningLoopback {
    pub fn set_vocal_preset(&self, preset: preset::VocalPreset) -> u64 {
        self.preset_control.request(preset)
    }

    pub fn vocal_preset(&self) -> (preset::VocalPreset, u64) {
        self.preset_control.snapshot()
    }

    pub fn sync_playback(
        &self,
        seconds: f64,
        playing: bool,
    ) -> playback_clock::PlaybackClockStatus {
        self.playback_clock.sync(seconds, playing)
    }

    pub fn playback_clock_status(&self) -> playback_clock::PlaybackClockStatus {
        self.playback_clock.status()
    }

    pub fn set_reference_rescue_enabled(&self, enabled: bool) -> bool {
        let applied = enabled && self.descriptor.reference_rescue_enabled;
        self.reference_rescue_control
            .store(applied, Ordering::Relaxed);
        applied
    }

    pub fn reference_rescue_enabled(&self) -> bool {
        self.reference_rescue_control.load(Ordering::Relaxed)
    }

    pub fn metrics(&self) -> LatencyMetrics {
        let processing_count = self.metrics.processing_count.load(Ordering::Relaxed);
        let processing_total_ns = self.metrics.processing_total_ns.load(Ordering::Relaxed);
        let queue_count = self.metrics.queue_depth_count.load(Ordering::Relaxed);
        let queue_total = self.metrics.queue_depth_total.load(Ordering::Relaxed);
        let input_buffer_ms = frames_to_ms(self.metrics.input_max_frames.load(Ordering::Relaxed));
        let output_buffer_ms = frames_to_ms(self.metrics.output_max_frames.load(Ordering::Relaxed));
        let queue_delay_ms = if queue_count == 0 {
            0.0
        } else {
            frames_to_ms(queue_total / queue_count)
        };
        let processing_ms = if processing_count == 0 {
            0.0
        } else {
            processing_total_ns as f64 / processing_count as f64 / 1_000_000.0
        };
        let underrun_events = self.metrics.underrun_events.load(Ordering::Relaxed);
        let overflow_events = self.metrics.overflow_events.load(Ordering::Relaxed);
        let stream_errors = self.metrics.stream_errors.load(Ordering::Relaxed);
        let quality_updates = self.metrics.quality_updates.load(Ordering::Relaxed);
        let reference_rescue_enabled = self.reference_rescue_enabled();
        LatencyMetrics {
            schema_version: 1,
            status: if underrun_events + overflow_events + stream_errors == 0 {
                "running".into()
            } else {
                "degraded".into()
            },
            sample_rate: SAMPLE_RATE,
            internal_format: INTERNAL_FORMAT.into(),
            input_device: self.descriptor.input_device.clone(),
            output_device: self.descriptor.output_device.clone(),
            input_channels: self.descriptor.input_channels,
            output_channels: self.descriptor.output_channels,
            input_channel: self.descriptor.input_channel,
            output_channel: self.descriptor.output_channel,
            buffer_frames_requested: self.descriptor.buffer_frames_requested,
            input_buffer_frames_configured: self.descriptor.input_buffer_frames_configured,
            output_buffer_frames_configured: self.descriptor.output_buffer_frames_configured,
            input_buffer_ms,
            processing_ms,
            output_buffer_ms,
            queue_delay_ms,
            estimated_software_path_ms: input_buffer_ms
                + processing_ms
                + queue_delay_ms
                + output_buffer_ms
                + self.descriptor.transform_algorithmic_latency_ms,
            pitch_correction_enabled: self.descriptor.pitch_correction_enabled,
            transform_algorithmic_latency_ms: self.descriptor.transform_algorithmic_latency_ms,
            pitch_analysis_window_ms: self.descriptor.pitch_analysis_window_ms,
            vocal_dynamics_enabled: self.descriptor.vocal_dynamics_enabled,
            vocal_quality_enabled: self.descriptor.vocal_quality_enabled,
            quality_score_latest: (quality_updates > 0)
                .then(|| self.metrics.quality_score_milli.load(Ordering::Relaxed) as f32 / 1_000.0),
            quality_class_latest: (quality_updates > 0).then(|| {
                quality::VocalQualityClass::from_code(
                    self.metrics.quality_class.load(Ordering::Relaxed),
                )
            }),
            adaptive_vocal_blend_enabled: self.descriptor.adaptive_vocal_blend_enabled,
            corrected_mix_latest: self
                .descriptor
                .adaptive_vocal_blend_enabled
                .then(|| self.metrics.corrected_mix_milli.load(Ordering::Relaxed) as f32 / 1_000.0),
            reference_rescue_enabled,
            reference_rescue_mix_latest: self.descriptor.reference_rescue_enabled.then(|| {
                self.metrics
                    .reference_rescue_mix_milli
                    .load(Ordering::Relaxed) as f32
                    / 1_000.0
            }),
            reference_rescue_active: reference_rescue_enabled
                && self
                    .metrics
                    .reference_rescue_mix_milli
                    .load(Ordering::Relaxed)
                    >= 10,
            round_trip_ms: None,
            round_trip_evidence:
                "not measured: physical output-to-input loopback evidence required".into(),
            xruns: underrun_events + overflow_events + stream_errors,
            underrun_events,
            overflow_events,
            dropped_frames: self.metrics.dropped_frames.load(Ordering::Relaxed),
            stream_errors,
            max_processing_ms: self.metrics.processing_max_ns.load(Ordering::Relaxed) as f64
                / 1_000_000.0,
            p95_processing_ms: self.metrics.percentile_ms(0.95),
            p99_processing_ms: self.metrics.percentile_ms(0.99),
            input_callbacks: self.metrics.input_callbacks.load(Ordering::Relaxed),
            output_callbacks: self.metrics.output_callbacks.load(Ordering::Relaxed),
            input_frames: self.metrics.input_frames.load(Ordering::Relaxed),
            output_frames: self.metrics.output_frames.load(Ordering::Relaxed),
        }
    }
}

pub fn benchmark_transfer(
    block_frames: usize,
    blocks: u64,
) -> Result<TransferBenchmark, EngineError> {
    if block_frames == 0 || blocks == 0 {
        return Err(EngineError("block_frames 和 blocks 必须大于 0".into()));
    }
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(block_frames + 1);
    let started_at = Instant::now();
    let mut checksum = 0.0_f64;
    for block in 0..blocks {
        for frame in 0..block_frames {
            let sample = ((block as usize ^ frame) & 0xff) as f32 / 255.0;
            producer
                .push(sample)
                .map_err(|_| EngineError("synthetic benchmark ring overflow".into()))?;
        }
        for _ in 0..block_frames {
            checksum += consumer
                .pop()
                .map_err(|_| EngineError("synthetic benchmark ring underrun".into()))?
                as f64;
        }
    }
    let elapsed = started_at.elapsed();
    let elapsed_ms = elapsed.as_secs_f64() * 1_000.0;
    let mean_processing_ms_per_block = elapsed_ms / blocks as f64;
    let block_budget_ms = frames_to_ms(block_frames as u64);
    Ok(TransferBenchmark {
        sample_rate: SAMPLE_RATE,
        block_frames,
        blocks,
        transferred_frames: block_frames as u64 * blocks,
        elapsed_ms,
        mean_processing_ms_per_block,
        realtime_budget_percent: mean_processing_ms_per_block / block_budget_ms * 100.0,
        checksum,
        scope: "synthetic lock-free transfer core only; excludes driver, USB and physical RTT"
            .into(),
    })
}

fn frames_to_ms(frames: u64) -> f64 {
    frames as f64 / SAMPLE_RATE as f64 * 1_000.0
}

pub fn run_for_duration(
    config: &LoopbackConfig,
    duration: Duration,
    stop: Arc<AtomicBool>,
    mut on_metrics: impl FnMut(&LatencyMetrics),
) -> Result<LatencyMetrics, EngineError> {
    let loopback = start_loopback(config)?;
    let started_at = Instant::now();
    while !stop.load(Ordering::Relaxed) && (duration.is_zero() || started_at.elapsed() < duration) {
        std::thread::sleep(Duration::from_secs(1));
        on_metrics(&loopback.metrics());
    }
    Ok(loopback.metrics())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_configuration_meets_p0_format_contract() {
        let config = LoopbackConfig::default();
        assert_eq!(SAMPLE_RATE, 48_000);
        assert_eq!(INTERNAL_FORMAT, "float32");
        assert!(config.ring_capacity_frames > config.prefill_frames);
        assert!(config.buffer_frames > 0);
        assert!(!config.pitch_correction_enabled);
    }

    #[test]
    fn histogram_percentiles_are_bounded_and_deterministic() {
        let metrics = AtomicMetrics::new();
        for micros in [10, 20, 70, 100, 1_000] {
            metrics.observe_processing(Duration::from_micros(micros));
        }
        assert_eq!(metrics.percentile_ms(0.95), 1.0);
        assert_eq!(metrics.percentile_ms(0.99), 1.0);
        assert!(metrics.processing_max_ns.load(Ordering::Relaxed) >= 1_000_000);
    }

    #[test]
    fn frame_latency_uses_broadcast_sample_rate() {
        assert!((frames_to_ms(480) - 10.0).abs() < f64::EPSILON);
        assert!((frames_to_ms(128) - 2.666_666_666_7).abs() < 0.000_001);
    }

    #[test]
    fn fixed_driver_buffer_is_resolved_without_false_low_latency_claim() {
        assert_eq!(
            resolve_buffer_frames(&SupportedBufferSize::Range { min: 480, max: 480 }, 128),
            480
        );
        assert_eq!(
            resolve_buffer_frames(&SupportedBufferSize::Unknown, 128),
            128
        );
    }

    #[test]
    fn synthetic_transfer_benchmark_moves_every_frame() {
        let result = benchmark_transfer(128, 32).expect("benchmark should complete");
        assert_eq!(result.transferred_frames, 4096);
        assert!(result.elapsed_ms >= 0.0);
        assert!(result.checksum > 0.0);
    }

    #[test]
    fn live_pitch_processor_rejects_an_incomplete_scale_target() {
        let config = LoopbackConfig {
            pitch_correction_enabled: true,
            key_tonic: Some(0),
            scale_mode: None,
            ..LoopbackConfig::default()
        };
        let control = preset::VocalPresetControl::new(config.vocal_preset);
        assert!(LiveVocalProcessor::new(&config, control.receiver()).is_err());
    }

    #[test]
    fn live_pitch_processor_has_a_finite_silence_path() {
        let config = LoopbackConfig {
            pitch_correction_enabled: true,
            ..LoopbackConfig::default()
        };
        let control = preset::VocalPresetControl::new(config.vocal_preset);
        let mut processor =
            LiveVocalProcessor::new(&config, control.receiver()).expect("valid live processor");
        for _ in 0..4096 {
            assert!(processor.process_sample(0.0).0.is_finite());
        }
    }

    #[test]
    fn adaptive_blend_cannot_run_without_pitch_correction() {
        let config = LoopbackConfig {
            adaptive_vocal_blend_enabled: true,
            ..LoopbackConfig::default()
        };
        let control = preset::VocalPresetControl::new(config.vocal_preset);
        assert!(LiveVocalProcessor::new(&config, control.receiver()).is_err());
    }
}
