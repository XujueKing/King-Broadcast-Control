use crate::{quality::VocalQualityClass, EngineError, SAMPLE_RATE};
use serde::Serialize;

const MAX_DELAY_FRAMES: usize = 1_024;

#[derive(Clone, Debug)]
pub struct AdaptiveVocalBlendConfig {
    pub preserve_threshold: f32,
    pub gentle_threshold: f32,
    pub strong_threshold: f32,
    pub gentle_corrected_mix: f32,
    pub strong_corrected_mix: f32,
    pub repair_corrected_mix: f32,
    pub correction_rise_ms: f32,
    pub correction_fall_ms: f32,
}

impl Default for AdaptiveVocalBlendConfig {
    fn default() -> Self {
        Self {
            preserve_threshold: 85.0,
            gentle_threshold: 65.0,
            strong_threshold: 40.0,
            gentle_corrected_mix: 0.35,
            strong_corrected_mix: 0.75,
            repair_corrected_mix: 1.0,
            correction_rise_ms: 45.0,
            correction_fall_ms: 180.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalBlendObservation {
    pub sample_position: u64,
    pub time_seconds: f64,
    pub quality_score: f32,
    pub quality_class: VocalQualityClass,
    pub target_corrected_mix: f32,
    pub corrected_mix: f32,
    pub dry_mix: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AdaptiveVocalBlendMetrics {
    pub processed_samples: u64,
    pub invalid_corrected_fallback_samples: u64,
    pub maximum_corrected_mix: f32,
    pub maximum_output_step: f32,
}

/// Fixed-size delay used to phase-align the live dry branch with the pitch
/// transform's four millisecond neutral delay before crossfading.
pub struct FixedDryDelay {
    samples: [f32; MAX_DELAY_FRAMES],
    write: usize,
    delay_frames: usize,
}

impl FixedDryDelay {
    pub fn new(delay_frames: usize) -> Result<Self, EngineError> {
        if delay_frames == 0 || delay_frames >= MAX_DELAY_FRAMES {
            return Err(EngineError(format!(
                "dry delay 必须在 1..{} frames",
                MAX_DELAY_FRAMES - 1
            )));
        }
        Ok(Self {
            samples: [0.0; MAX_DELAY_FRAMES],
            write: 0,
            delay_frames,
        })
    }

    pub fn process_sample(&mut self, sample: f32) -> f32 {
        let read = (self.write + MAX_DELAY_FRAMES - self.delay_frames) % MAX_DELAY_FRAMES;
        let delayed = self.samples[read];
        self.samples[self.write] = if sample.is_finite() { sample } else { 0.0 };
        self.write = (self.write + 1) % MAX_DELAY_FRAMES;
        delayed
    }

    pub fn process_block(&mut self, input: &[f32], output: &mut [f32]) {
        debug_assert_eq!(input.len(), output.len());
        for (sample, destination) in input.iter().copied().zip(output) {
            *destination = self.process_sample(sample);
        }
    }
}

/// Quality-driven linear crossfade between latency-aligned dry and corrected
/// vocals. Linear gains deliberately sum to one, preventing the +3 dB rise a
/// constant-power crossfade can create for these strongly correlated signals.
pub struct AdaptiveVocalBlender {
    config: AdaptiveVocalBlendConfig,
    target_corrected_mix: f32,
    corrected_mix: f32,
    rise_alpha: f32,
    fall_alpha: f32,
    previous_output: f32,
    metrics: AdaptiveVocalBlendMetrics,
}

impl AdaptiveVocalBlender {
    pub fn new(config: AdaptiveVocalBlendConfig) -> Result<Self, EngineError> {
        validate(&config)?;
        Ok(Self {
            rise_alpha: smoothing_alpha(config.correction_rise_ms),
            fall_alpha: smoothing_alpha(config.correction_fall_ms),
            config,
            target_corrected_mix: 0.0,
            corrected_mix: 0.0,
            previous_output: 0.0,
            metrics: AdaptiveVocalBlendMetrics::default(),
        })
    }

    pub fn set_quality_score(&mut self, quality_score: f32) {
        self.target_corrected_mix = self.corrected_mix_for_score(quality_score);
    }

    pub fn corrected_mix_for_score(&self, quality_score: f32) -> f32 {
        let score = if quality_score.is_finite() {
            quality_score.clamp(0.0, 100.0)
        } else {
            100.0
        };
        if score >= self.config.preserve_threshold {
            0.0
        } else if score >= self.config.gentle_threshold {
            interpolate_descending(
                score,
                self.config.gentle_threshold,
                self.config.preserve_threshold,
                self.config.gentle_corrected_mix,
                0.0,
            )
        } else if score >= self.config.strong_threshold {
            interpolate_descending(
                score,
                self.config.strong_threshold,
                self.config.gentle_threshold,
                self.config.strong_corrected_mix,
                self.config.gentle_corrected_mix,
            )
        } else {
            interpolate_descending(
                score,
                0.0,
                self.config.strong_threshold,
                self.config.repair_corrected_mix,
                self.config.strong_corrected_mix,
            )
        }
        .clamp(0.0, 1.0)
    }

    pub fn process_sample(&mut self, dry: f32, corrected: f32) -> f32 {
        let safe_dry = if dry.is_finite() { dry } else { 0.0 };
        let safe_corrected = if corrected.is_finite() {
            corrected
        } else {
            self.metrics.invalid_corrected_fallback_samples += 1;
            safe_dry
        };
        let alpha = if self.target_corrected_mix > self.corrected_mix {
            self.rise_alpha
        } else {
            self.fall_alpha
        };
        self.corrected_mix += alpha * (self.target_corrected_mix - self.corrected_mix);
        self.corrected_mix = self.corrected_mix.clamp(0.0, 1.0);
        let output = safe_dry + self.corrected_mix * (safe_corrected - safe_dry);
        let safe_output = if output.is_finite() { output } else { safe_dry };
        self.metrics.maximum_output_step = self
            .metrics
            .maximum_output_step
            .max((safe_output - self.previous_output).abs());
        self.previous_output = safe_output;
        self.metrics.processed_samples += 1;
        self.metrics.maximum_corrected_mix =
            self.metrics.maximum_corrected_mix.max(self.corrected_mix);
        safe_output
    }

    pub fn process_block(&mut self, dry: &[f32], corrected: &[f32], output: &mut [f32]) {
        debug_assert_eq!(dry.len(), corrected.len());
        debug_assert_eq!(dry.len(), output.len());
        for ((dry, corrected), destination) in dry
            .iter()
            .copied()
            .zip(corrected.iter().copied())
            .zip(output)
        {
            *destination = self.process_sample(dry, corrected);
        }
    }

    pub fn corrected_mix(&self) -> f32 {
        self.corrected_mix
    }

    pub fn target_corrected_mix(&self) -> f32 {
        self.target_corrected_mix
    }

    pub fn metrics(&self) -> AdaptiveVocalBlendMetrics {
        self.metrics
    }
}

fn validate(config: &AdaptiveVocalBlendConfig) -> Result<(), EngineError> {
    let thresholds_valid = (0.0..=100.0).contains(&config.strong_threshold)
        && (config.strong_threshold..=100.0).contains(&config.gentle_threshold)
        && (config.gentle_threshold..=100.0).contains(&config.preserve_threshold);
    let mixes_valid = (0.0..=1.0).contains(&config.gentle_corrected_mix)
        && (config.gentle_corrected_mix..=1.0).contains(&config.strong_corrected_mix)
        && (config.strong_corrected_mix..=1.0).contains(&config.repair_corrected_mix);
    let times_valid = (1.0..=2_000.0).contains(&config.correction_rise_ms)
        && (1.0..=2_000.0).contains(&config.correction_fall_ms);
    if !thresholds_valid || !mixes_valid || !times_valid {
        return Err(EngineError("Adaptive Vocal Blend 配置无效".into()));
    }
    Ok(())
}

fn smoothing_alpha(milliseconds: f32) -> f32 {
    1.0 - (-1.0 / (milliseconds * 0.001 * SAMPLE_RATE as f32)).exp()
}

fn interpolate_descending(value: f32, low: f32, high: f32, at_low: f32, at_high: f32) -> f32 {
    let position = ((value - low) / (high - low)).clamp(0.0, 1.0);
    at_low + position * (at_high - at_low)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_mapping_is_continuous_and_monotonic() {
        let blender = AdaptiveVocalBlender::new(AdaptiveVocalBlendConfig::default()).unwrap();
        let samples = [100.0, 85.0, 75.0, 65.0, 52.5, 40.0, 20.0, 0.0]
            .map(|score| blender.corrected_mix_for_score(score));
        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[1], 0.0);
        assert!((samples[3] - 0.35).abs() < 1.0e-6);
        assert!((samples[5] - 0.75).abs() < 1.0e-6);
        assert_eq!(samples[7], 1.0);
        assert!(samples.windows(2).all(|pair| pair[1] >= pair[0]));
    }

    #[test]
    fn aligned_identical_branches_never_gain_level() {
        let mut blender = AdaptiveVocalBlender::new(AdaptiveVocalBlendConfig::default()).unwrap();
        blender.set_quality_score(0.0);
        for _ in 0..SAMPLE_RATE {
            assert!((blender.process_sample(0.4, 0.4) - 0.4).abs() < 1.0e-6);
        }
    }

    #[test]
    fn correction_mix_rises_and_falls_without_a_hard_switch() {
        let mut blender = AdaptiveVocalBlender::new(AdaptiveVocalBlendConfig::default()).unwrap();
        blender.set_quality_score(0.0);
        let first = blender.process_sample(0.5, -0.5);
        for _ in 1..2_160 {
            blender.process_sample(0.5, -0.5);
        }
        let risen = blender.corrected_mix();
        blender.set_quality_score(100.0);
        let before_fall = blender.corrected_mix();
        blender.process_sample(0.5, -0.5);
        assert!(first < 0.5 && first > 0.49);
        assert!(risen > 0.60 && risen < 0.70);
        assert!(blender.corrected_mix() < before_fall);
        assert!(blender.corrected_mix() > before_fall - 0.001);
    }

    #[test]
    fn dry_delay_matches_the_pitch_transform_latency() {
        let delay = crate::formant::FormantPreservingPitchShifter::algorithmic_latency_frames();
        let mut dry = FixedDryDelay::new(delay).unwrap();
        assert_eq!(dry.process_sample(1.0), 0.0);
        for _ in 1..delay {
            assert_eq!(dry.process_sample(0.0), 0.0);
        }
        assert_eq!(dry.process_sample(0.0), 1.0);
    }

    #[test]
    fn invalid_corrected_sample_falls_back_to_dry() {
        let mut blender = AdaptiveVocalBlender::new(AdaptiveVocalBlendConfig::default()).unwrap();
        blender.set_quality_score(0.0);
        assert_eq!(blender.process_sample(0.25, f32::NAN), 0.25);
        assert_eq!(blender.metrics().invalid_corrected_fallback_samples, 1);
    }
}
