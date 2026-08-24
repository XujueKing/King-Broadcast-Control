use crate::{EngineError, SAMPLE_RATE};

const LPC_ORDER: usize = 16;
const ANALYSIS_FRAMES: usize = 1_024;
const DELAY_FRAMES: usize = 1_024;
const GRAIN_SPAN_FRAMES: usize = 384;
const NEUTRAL_DELAY_FRAMES: usize = GRAIN_SPAN_FRAMES / 2;

#[derive(Clone, Debug)]
pub struct FormantShifterConfig {
    pub maximum_correction_cents: f32,
    pub coefficient_smoothing: f32,
    pub ratio_smoothing_ms: f32,
    pub transient_threshold: f32,
}

impl Default for FormantShifterConfig {
    fn default() -> Self {
        Self {
            maximum_correction_cents: 200.0,
            coefficient_smoothing: 0.18,
            ratio_smoothing_ms: 6.0,
            transient_threshold: 0.18,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct FormantShifterMetrics {
    pub processed_samples: u64,
    pub transient_bypass_samples: u64,
    pub invalid_fallback_samples: u64,
    pub maximum_absolute_output: f32,
}

/// Fixed-memory LPC-envelope / granular-excitation shifter.
///
/// Pitch is applied to the LPC residual while the original vocal-tract filter
/// is reused for synthesis. This keeps the formant envelope independent from
/// the requested F0 ratio. Construction allocates no heap memory and
/// `process_block` performs no allocation, locking or I/O.
pub struct FormantPreservingPitchShifter {
    config: FormantShifterConfig,
    analysis: [f32; ANALYSIS_FRAMES],
    analysis_scratch: [f32; ANALYSIS_FRAMES],
    analysis_write: usize,
    analysis_filled: usize,
    samples_since_lpc_update: usize,
    lpc: [f32; LPC_ORDER],
    input_history: [f32; LPC_ORDER],
    output_history: [f32; LPC_ORDER],
    residual_delay: [f32; DELAY_FRAMES],
    dry_delay: [f32; DELAY_FRAMES],
    delay_write: usize,
    grain_phase: f32,
    ratio: f32,
    wet: f32,
    previous_input: f32,
    metrics: FormantShifterMetrics,
}

impl FormantPreservingPitchShifter {
    pub fn new(config: FormantShifterConfig) -> Result<Self, EngineError> {
        if !config.maximum_correction_cents.is_finite()
            || !(1.0..=400.0).contains(&config.maximum_correction_cents)
            || !config.coefficient_smoothing.is_finite()
            || !(0.0..=1.0).contains(&config.coefficient_smoothing)
            || !config.ratio_smoothing_ms.is_finite()
            || !(0.1..=100.0).contains(&config.ratio_smoothing_ms)
            || !config.transient_threshold.is_finite()
            || !(0.01..=1.0).contains(&config.transient_threshold)
        {
            return Err(EngineError("Formant shifter 配置无效".into()));
        }
        Ok(Self {
            config,
            analysis: [0.0; ANALYSIS_FRAMES],
            analysis_scratch: [0.0; ANALYSIS_FRAMES],
            analysis_write: 0,
            analysis_filled: 0,
            samples_since_lpc_update: 0,
            lpc: [0.0; LPC_ORDER],
            input_history: [0.0; LPC_ORDER],
            output_history: [0.0; LPC_ORDER],
            residual_delay: [0.0; DELAY_FRAMES],
            dry_delay: [0.0; DELAY_FRAMES],
            delay_write: 0,
            grain_phase: 0.0,
            ratio: 1.0,
            wet: 0.0,
            previous_input: 0.0,
            metrics: FormantShifterMetrics::default(),
        })
    }

    pub const fn algorithmic_latency_frames() -> usize {
        NEUTRAL_DELAY_FRAMES
    }

    pub fn algorithmic_latency_ms() -> f32 {
        Self::algorithmic_latency_frames() as f32 / SAMPLE_RATE as f32 * 1_000.0
    }

    pub fn metrics(&self) -> FormantShifterMetrics {
        self.metrics
    }

    pub fn process_block(&mut self, input: &[f32], output: &mut [f32], correction_cents: f32) {
        debug_assert_eq!(input.len(), output.len());
        for sample in input {
            self.analysis[self.analysis_write] = sample.clamp(-1.0, 1.0);
            self.analysis_write = (self.analysis_write + 1) % ANALYSIS_FRAMES;
            self.analysis_filled = (self.analysis_filled + 1).min(ANALYSIS_FRAMES);
            self.samples_since_lpc_update += 1;
        }
        if self.analysis_filled == ANALYSIS_FRAMES && self.samples_since_lpc_update >= 128 {
            self.samples_since_lpc_update = 0;
            self.update_lpc();
        }

        let safe_cents = if correction_cents.is_finite() {
            correction_cents.clamp(
                -self.config.maximum_correction_cents,
                self.config.maximum_correction_cents,
            )
        } else {
            0.0
        };
        let target_ratio = 2.0_f32.powf(safe_cents / 1_200.0);
        let ratio_alpha =
            1.0 - (-1.0 / (self.config.ratio_smoothing_ms * 0.001 * SAMPLE_RATE as f32)).exp();
        let wet_alpha = 1.0 - (-1.0 / (0.004 * SAMPLE_RATE as f32)).exp();

        for (source, destination) in input.iter().zip(output) {
            let source = source.clamp(-1.0, 1.0);
            self.ratio += ratio_alpha * (target_ratio - self.ratio);
            let residual = self.analysis_residual(source);
            self.residual_delay[self.delay_write] = residual;
            self.dry_delay[self.delay_write] = source;

            let shifted_residual = self.read_shifted_residual(self.ratio);
            let synthesized = self.synthesize(shifted_residual);
            let dry = self.read_delay(&self.dry_delay, NEUTRAL_DELAY_FRAMES as f32);
            let transient = (source - self.previous_input).abs() >= self.config.transient_threshold;
            self.previous_input = source;
            let target_wet = if transient || safe_cents.abs() < 0.5 {
                if transient {
                    self.metrics.transient_bypass_samples += 1;
                }
                0.0
            } else {
                1.0
            };
            self.wet += wet_alpha * (target_wet - self.wet);
            let candidate = dry + self.wet * (synthesized - dry);
            let safe = if candidate.is_finite() && candidate.abs() <= 8.0 {
                candidate.clamp(-1.0, 1.0)
            } else {
                self.metrics.invalid_fallback_samples += 1;
                self.output_history.fill(0.0);
                dry
            };
            *destination = safe;
            self.metrics.processed_samples += 1;
            self.metrics.maximum_absolute_output =
                self.metrics.maximum_absolute_output.max(safe.abs());
            self.delay_write = (self.delay_write + 1) % DELAY_FRAMES;
        }
    }

    fn update_lpc(&mut self) {
        for index in 0..ANALYSIS_FRAMES {
            self.analysis_scratch[index] =
                self.analysis[(self.analysis_write + index) % ANALYSIS_FRAMES];
        }
        let mean = self.analysis_scratch.iter().sum::<f32>() / ANALYSIS_FRAMES as f32;
        for sample in &mut self.analysis_scratch {
            *sample -= mean;
        }
        let mut autocorrelation = [0.0_f64; LPC_ORDER + 1];
        for (lag, result) in autocorrelation.iter_mut().enumerate() {
            let mut value = 0.0_f64;
            for index in lag..ANALYSIS_FRAMES {
                value +=
                    self.analysis_scratch[index] as f64 * self.analysis_scratch[index - lag] as f64;
            }
            *result = value;
        }
        if autocorrelation[0] < 1.0e-7 {
            for coefficient in &mut self.lpc {
                *coefficient *= 0.95;
            }
            return;
        }
        let mut polynomial = [0.0_f64; LPC_ORDER + 1];
        polynomial[0] = 1.0;
        let mut error = autocorrelation[0].max(1.0e-12);
        for order in 1..=LPC_ORDER {
            let mut accumulated = autocorrelation[order];
            for index in 1..order {
                accumulated += polynomial[index] * autocorrelation[order - index];
            }
            let reflection = (-accumulated / error).clamp(-0.96, 0.96);
            let previous = polynomial;
            for index in 1..order {
                polynomial[index] = previous[index] + reflection * previous[order - index];
            }
            polynomial[order] = reflection;
            error = (error * (1.0 - reflection * reflection)).max(1.0e-12);
        }
        for (destination, source) in self.lpc.iter_mut().zip(&polynomial[1..]) {
            let target = *source as f32;
            *destination += self.config.coefficient_smoothing * (target - *destination);
        }
    }

    fn analysis_residual(&mut self, sample: f32) -> f32 {
        let residual = self
            .lpc
            .iter()
            .zip(self.input_history)
            .fold(sample, |value, (coefficient, history)| {
                value + coefficient * history
            });
        self.input_history.rotate_right(1);
        self.input_history[0] = sample;
        residual.clamp(-4.0, 4.0)
    }

    fn synthesize(&mut self, residual: f32) -> f32 {
        let output = self
            .lpc
            .iter()
            .zip(self.output_history)
            .fold(residual, |value, (coefficient, history)| {
                value - coefficient * history
            });
        self.output_history.rotate_right(1);
        self.output_history[0] = if output.is_finite() { output } else { 0.0 };
        output
    }

    fn read_shifted_residual(&mut self, ratio: f32) -> f32 {
        self.grain_phase =
            (self.grain_phase + (1.0 - ratio) / GRAIN_SPAN_FRAMES as f32).rem_euclid(1.0);
        let second_phase = (self.grain_phase + 0.5).fract();
        let first_weight = (std::f32::consts::PI * self.grain_phase).sin().powi(2);
        let second_weight = (std::f32::consts::PI * second_phase).sin().powi(2);
        let first = self.read_delay(
            &self.residual_delay,
            1.0 + self.grain_phase * GRAIN_SPAN_FRAMES as f32,
        );
        let second = self.read_delay(
            &self.residual_delay,
            1.0 + second_phase * GRAIN_SPAN_FRAMES as f32,
        );
        first * first_weight + second * second_weight
    }

    fn read_delay(&self, buffer: &[f32; DELAY_FRAMES], delay: f32) -> f32 {
        let position = (self.delay_write as f32 - delay).rem_euclid(DELAY_FRAMES as f32);
        let left = position.floor() as usize % DELAY_FRAMES;
        let right = (left + 1) % DELAY_FRAMES;
        let fraction = position - position.floor();
        buffer[left] + fraction * (buffer[right] - buffer[left])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pitch::{PitchTracker, PitchTrackerConfig};
    use std::f32::consts::TAU;

    fn shifted_tone(input_hz: f32, cents: f32) -> (Vec<f32>, FormantShifterMetrics) {
        let samples = (0..SAMPLE_RATE as usize)
            .map(|index| 0.25 * (TAU * input_hz * index as f32 / SAMPLE_RATE as f32).sin())
            .collect::<Vec<_>>();
        let mut output = vec![0.0; samples.len()];
        let mut shifter = FormantPreservingPitchShifter::new(FormantShifterConfig::default())
            .expect("valid shifter");
        for (input, output) in samples.chunks(128).zip(output.chunks_mut(128)) {
            shifter.process_block(input, output, cents);
        }
        (output, shifter.metrics())
    }

    fn tracked_mean(samples: &[f32]) -> f32 {
        let mut tracker = PitchTracker::new(PitchTrackerConfig::default()).unwrap();
        let voiced = samples
            .chunks(128)
            .filter_map(|block| tracker.process_block(block))
            .skip(20)
            .filter_map(|observation| observation.f0_hz)
            .collect::<Vec<_>>();
        voiced.iter().sum::<f32>() / voiced.len() as f32
    }

    #[test]
    fn reports_a_four_millisecond_fixed_latency() {
        assert_eq!(
            FormantPreservingPitchShifter::algorithmic_latency_frames(),
            192
        );
        assert!((FormantPreservingPitchShifter::algorithmic_latency_ms() - 4.0).abs() < 0.001);
    }

    #[test]
    fn shifts_excitation_down_one_semitone_without_nan() {
        let (output, metrics) = shifted_tone(466.16376, -100.0);
        let output_hz = tracked_mean(&output[4_800..]);
        assert!((output_hz - 440.0).abs() < 8.0, "output F0 was {output_hz}");
        assert_eq!(metrics.invalid_fallback_samples, 0);
        assert!(output.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn invalid_control_falls_back_to_neutral_processing() {
        let (output, metrics) = shifted_tone(440.0, f32::NAN);
        let output_hz = tracked_mean(&output[4_800..]);
        assert!((output_hz - 440.0).abs() < 3.0, "output F0 was {output_hz}");
        assert_eq!(metrics.invalid_fallback_samples, 0);
    }
}
