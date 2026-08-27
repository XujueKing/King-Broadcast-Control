use crate::{EngineError, SAMPLE_RATE};
use claxon::FlacReader;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct ReferenceRescueConfig {
    pub trigger_score: f32,
    pub recovery_score: f32,
    pub trigger_hold_ms: f32,
    pub recovery_hold_ms: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub maximum_mix: f32,
    pub reference_gain_db: f32,
    pub start_delay_ms: f32,
    pub singer_detection_level: f32,
    pub quiet_singer_level: f32,
    pub confident_singer_level: f32,
}

impl Default for ReferenceRescueConfig {
    fn default() -> Self {
        Self {
            trigger_score: 40.0,
            recovery_score: 70.0,
            trigger_hold_ms: 35.0,
            recovery_hold_ms: 160.0,
            attack_ms: 32.0,
            release_ms: 180.0,
            maximum_mix: 0.92,
            reference_gain_db: 0.0,
            start_delay_ms: 0.0,
            singer_detection_level: 0.004,
            quiet_singer_level: 0.012,
            confident_singer_level: 0.080,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ReferenceRescueFrame {
    pub sample: f32,
    pub mix: f32,
    pub active: bool,
    pub singer_detected: bool,
    pub live_level: f32,
    pub loudness_need: f32,
    pub quality_need: f32,
}

/// Pre-decoded mono reference vocal blended adaptively against the detected singer.
/// File I/O and allocation happen before the realtime streams are started.
pub struct ReferenceVocalRescue {
    samples: Vec<f32>,
    start_delay_frames: i64,
    trigger_score: f32,
    recovery_score: f32,
    attack_step: f32,
    release_step: f32,
    maximum_mix: f32,
    reference_gain: f32,
    singer_detection_level: f32,
    quiet_singer_level: f32,
    confident_singer_level: f32,
    live_envelope: f32,
    mix: f32,
    target_mix: f32,
}

impl ReferenceVocalRescue {
    pub fn load(path: &Path, config: ReferenceRescueConfig) -> Result<Self, EngineError> {
        validate(&config)?;
        let samples = load_mono_flac(path)?;
        if samples.is_empty() {
            return Err(EngineError(format!("参考救援人声为空：{}", path.display())));
        }
        Ok(Self::from_samples(samples, config))
    }

    fn from_samples(samples: Vec<f32>, config: ReferenceRescueConfig) -> Self {
        let frames_for_ms = |milliseconds: f32| {
            (milliseconds * SAMPLE_RATE as f32 / 1_000.0)
                .round()
                .max(1.0) as u64
        };
        let attack_frames = frames_for_ms(config.attack_ms) as f32;
        let release_frames = frames_for_ms(config.release_ms) as f32;
        Self {
            samples,
            start_delay_frames: (config.start_delay_ms * SAMPLE_RATE as f32 / 1_000.0).round()
                as i64,
            trigger_score: config.trigger_score,
            recovery_score: config.recovery_score,
            attack_step: config.maximum_mix / attack_frames,
            release_step: config.maximum_mix / release_frames,
            maximum_mix: config.maximum_mix,
            reference_gain: 10.0_f32.powf(config.reference_gain_db / 20.0),
            singer_detection_level: config.singer_detection_level,
            quiet_singer_level: config.quiet_singer_level,
            confident_singer_level: config.confident_singer_level,
            live_envelope: 0.0,
            mix: 0.0,
            target_mix: 0.0,
        }
    }

    pub fn process_sample(
        &mut self,
        live: f32,
        reference_voice_expected: bool,
        quality_score: f32,
        sample_position: u64,
        playing: bool,
    ) -> ReferenceRescueFrame {
        if !playing {
            self.target_mix = 0.0;
            self.mix = 0.0;
            return ReferenceRescueFrame {
                sample: live.clamp(-1.0, 1.0),
                mix: 0.0,
                active: false,
                singer_detected: false,
                live_level: self.live_envelope,
                loudness_need: 0.0,
                quality_need: 0.0,
            };
        }
        let reference_position = sample_position as i64 - self.start_delay_frames;
        let reference = if reference_position >= 0 {
            self.samples
                .get(reference_position as usize)
                .copied()
                .unwrap_or(0.0)
        } else {
            0.0
        };

        // The Deck's 补音 switch is the only operator gate. Inside voiced song
        // regions, both singer loudness and pitch/quality continuously express
        // how much help is needed. Taking the stronger need keeps a quiet but
        // accurate singer supported and also covers a loud but inaccurate singer.
        let quality = if quality_score.is_finite() {
            quality_score.clamp(0.0, 100.0)
        } else {
            0.0
        };
        let amplitude = live.abs();
        let envelope_coefficient = if amplitude > self.live_envelope {
            0.08
        } else {
            0.002
        };
        self.live_envelope += (amplitude - self.live_envelope) * envelope_coefficient;
        let singer_detected = self.live_envelope >= self.singer_detection_level;
        let loudness_need = if self.live_envelope <= self.quiet_singer_level {
            1.0
        } else if self.live_envelope >= self.confident_singer_level {
            0.0
        } else {
            (self.confident_singer_level - self.live_envelope)
                / (self.confident_singer_level - self.quiet_singer_level)
        };
        let quality_need = if !singer_detected || quality <= self.trigger_score {
            1.0
        } else if quality >= self.recovery_score {
            0.0
        } else {
            (self.recovery_score - quality) / (self.recovery_score - self.trigger_score)
        };
        if !reference_voice_expected {
            self.target_mix = 0.0;
        } else {
            self.target_mix = self.maximum_mix * loudness_need.max(quality_need);
        }

        if self.mix < self.target_mix {
            self.mix = (self.mix + self.attack_step).min(self.target_mix);
        } else if self.mix > self.target_mix {
            self.mix = (self.mix - self.release_step).max(self.target_mix);
        }
        let rescued =
            (live * (1.0 - self.mix) + reference * self.reference_gain * self.mix).clamp(-1.0, 1.0);
        ReferenceRescueFrame {
            sample: rescued,
            mix: self.mix,
            active: self.mix >= 0.01,
            singer_detected,
            live_level: self.live_envelope,
            loudness_need,
            quality_need,
        }
    }
}

fn validate(config: &ReferenceRescueConfig) -> Result<(), EngineError> {
    if !(0.0..=80.0).contains(&config.trigger_score)
        || !(40.0..=100.0).contains(&config.recovery_score)
        || config.trigger_score >= config.recovery_score
        || !(5.0..=500.0).contains(&config.trigger_hold_ms)
        || !(20.0..=2_000.0).contains(&config.recovery_hold_ms)
        || !(5.0..=500.0).contains(&config.attack_ms)
        || !(20.0..=2_000.0).contains(&config.release_ms)
        || !(0.0..=1.0).contains(&config.maximum_mix)
        || !(-60.0..=6.0).contains(&config.reference_gain_db)
        || !(0.0..=5_000.0).contains(&config.start_delay_ms)
        || !(0.0001..=0.1).contains(&config.singer_detection_level)
        || !(config.singer_detection_level..=0.25).contains(&config.quiet_singer_level)
        || !(config.quiet_singer_level..=0.5).contains(&config.confident_singer_level)
        || config.quiet_singer_level >= config.confident_singer_level
    {
        return Err(EngineError("参考人声救援配置无效".into()));
    }
    Ok(())
}

fn load_mono_flac(path: &Path) -> Result<Vec<f32>, EngineError> {
    let mut reader = FlacReader::open(path)
        .map_err(|error| EngineError(format!("无法读取参考人声 {}：{error}", path.display())))?;
    let stream = reader.streaminfo();
    if !(8_000..=192_000).contains(&stream.sample_rate) {
        return Err(EngineError(format!(
            "参考人声采样率无效：{} Hz",
            stream.sample_rate
        )));
    }
    let channels = stream.channels as usize;
    if channels == 0 {
        return Err(EngineError("参考人声通道数无效".into()));
    }
    let scale = 2.0_f32.powi(stream.bits_per_sample as i32 - 1);
    let decoded = reader
        .samples()
        .map(|sample| {
            sample
                .map(|value| value as f32 / scale)
                .map_err(|error| EngineError(format!("参考人声 FLAC 解码失败：{error}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut mono = Vec::with_capacity(decoded.len() / channels);
    for frame in decoded.chunks_exact(channels) {
        mono.push(frame.iter().sum::<f32>() / channels as f32);
    }
    if stream.sample_rate == SAMPLE_RATE {
        Ok(mono)
    } else {
        Ok(resample_mono_cubic(&mono, stream.sample_rate, SAMPLE_RATE))
    }
}

/// Offline cubic resampling for prepared rescue stems. It runs once before the realtime
/// streams start; the audio callback always consumes the resulting 48 kHz buffer directly.
fn resample_mono_cubic(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if source_rate == target_rate {
        return input.to_vec();
    }
    let output_len =
        (input.len() as u64 * target_rate as u64).div_ceil(source_rate as u64) as usize;
    let source_per_output = source_rate as f64 / target_rate as f64;
    let sample_at = |index: isize| input[index.clamp(0, input.len() as isize - 1) as usize];
    let mut output = Vec::with_capacity(output_len);
    for output_index in 0..output_len {
        let source_position = output_index as f64 * source_per_output;
        let center = source_position.floor() as isize;
        let fraction = (source_position - center as f64) as f32;
        let y0 = sample_at(center - 1);
        let y1 = sample_at(center);
        let y2 = sample_at(center + 1);
        let y3 = sample_at(center + 2);
        let a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
        let a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        let a2 = -0.5 * y0 + 0.5 * y2;
        output.push((((a0 * fraction + a1) * fraction + a2) * fraction + y1).clamp(-1.0, 1.0));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_rescue() -> ReferenceVocalRescue {
        ReferenceVocalRescue::from_samples(
            vec![0.5; SAMPLE_RATE as usize],
            ReferenceRescueConfig {
                trigger_hold_ms: 5.0,
                recovery_hold_ms: 20.0,
                attack_ms: 5.0,
                release_ms: 20.0,
                maximum_mix: 1.0,
                reference_gain_db: 0.0,
                ..ReferenceRescueConfig::default()
            },
        )
    }

    #[test]
    fn absent_singer_gets_full_reference_and_high_score_fades_it_out() {
        let mut rescue = test_rescue();
        let mut frame = ReferenceRescueFrame::default();
        for position in 0..(SAMPLE_RATE / 50) {
            frame = rescue.process_sample(0.0, true, 95.0, position as u64, true);
        }
        assert!(frame.active);
        assert!(frame.mix > 0.95);
        assert!(frame.sample > 0.45);
        for position in (SAMPLE_RATE / 50)..(SAMPLE_RATE / 5 + SAMPLE_RATE / 50) {
            frame = rescue.process_sample(0.25, true, 95.0, position as u64, true);
        }
        assert!(!frame.active);
        assert!((frame.sample - 0.25).abs() < 1.0e-4);
    }

    #[test]
    fn detected_singer_score_continuously_controls_reference_mix() {
        let mut rescue = test_rescue();
        let mut frame = ReferenceRescueFrame::default();
        for position in 0..(SAMPLE_RATE / 20) {
            frame = rescue.process_sample(0.25, true, 55.0, position as u64, true);
        }
        assert!(frame.active);
        assert!((frame.mix - 0.5).abs() < 0.01);
        assert!((frame.sample - 0.375).abs() < 0.01);
    }

    #[test]
    fn quiet_singer_gets_loudness_support_even_with_a_high_score() {
        let mut rescue = test_rescue();
        let mut frame = ReferenceRescueFrame::default();
        for position in 0..(SAMPLE_RATE / 10) {
            frame = rescue.process_sample(0.008, true, 95.0, position as u64, true);
        }
        assert!(frame.singer_detected);
        assert!(frame.loudness_need > 0.95);
        assert_eq!(frame.quality_need, 0.0);
        assert!(frame.mix > 0.95);
    }

    #[test]
    fn louder_singer_reduces_support_monotonically_at_the_same_score() {
        let settled_mix = |level: f32| {
            let mut rescue = test_rescue();
            let mut frame = ReferenceRescueFrame::default();
            for position in 0..(SAMPLE_RATE / 4) {
                frame = rescue.process_sample(level, true, 95.0, position as u64, true);
            }
            frame.mix
        };
        let quiet = settled_mix(0.015);
        let medium = settled_mix(0.040);
        let loud = settled_mix(0.120);
        assert!(quiet > medium);
        assert!(medium > loud);
        assert!(loud < 0.01);
    }

    #[test]
    fn poor_score_keeps_support_high_even_for_a_loud_singer() {
        let mut rescue = test_rescue();
        let mut frame = ReferenceRescueFrame::default();
        for position in 0..(SAMPLE_RATE / 10) {
            frame = rescue.process_sample(0.20, true, 20.0, position as u64, true);
        }
        assert!(frame.singer_detected);
        assert!(frame.loudness_need < 0.01);
        assert!(frame.quality_need > 0.99);
        assert!(frame.mix > 0.95);
    }

    #[test]
    fn instrumental_gap_never_opens_reference_rescue() {
        let mut rescue = test_rescue();
        let mut maximum_mix = 0.0_f32;
        for position in 0..(SAMPLE_RATE / 2) {
            maximum_mix = maximum_mix.max(
                rescue
                    .process_sample(0.1, false, 0.0, position as u64, true)
                    .mix,
            );
        }
        assert_eq!(maximum_mix, 0.0);
    }

    #[test]
    fn absolute_position_supports_seek_and_pause_without_reference_leak() {
        let mut rescue = ReferenceVocalRescue::from_samples(
            (0..SAMPLE_RATE)
                .map(|position| position as f32 / SAMPLE_RATE as f32)
                .collect(),
            ReferenceRescueConfig {
                trigger_hold_ms: 5.0,
                attack_ms: 5.0,
                maximum_mix: 1.0,
                reference_gain_db: 0.0,
                ..ReferenceRescueConfig::default()
            },
        );
        let target = SAMPLE_RATE as u64 / 2;
        let mut frame = ReferenceRescueFrame::default();
        for position in (target - 700)..target {
            frame = rescue.process_sample(0.0, true, 0.0, position, true);
        }
        assert!(frame.sample > 0.45);
        for _ in 0..300 {
            frame = rescue.process_sample(0.0, true, 0.0, target, false);
        }
        assert!(frame.mix < 0.01);
        assert_eq!(frame.sample, 0.0);
    }

    #[test]
    fn offline_resampler_preserves_duration_and_finite_audio() {
        let input = (0..44_100)
            .map(|index| ((index as f32 / 44_100.0) * std::f32::consts::TAU * 440.0).sin())
            .collect::<Vec<_>>();
        let output = resample_mono_cubic(&input, 44_100, SAMPLE_RATE);
        assert_eq!(output.len(), SAMPLE_RATE as usize);
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert!(output.iter().all(|sample| sample.abs() <= 1.0));
    }
}
