use crate::{EngineError, SAMPLE_RATE};

#[derive(Clone, Debug)]
pub struct VocalDynamicsConfig {
    pub high_pass_hz: f32,
    pub presence_hz: f32,
    pub presence_gain_db: f32,
    pub deesser_hz: f32,
    pub deesser_threshold_dbfs: f32,
    pub deesser_ratio: f32,
    pub compressor_threshold_dbfs: f32,
    pub compressor_ratio: f32,
    pub compressor_attack_ms: f32,
    pub compressor_release_ms: f32,
    pub makeup_gain_db: f32,
    pub limiter_ceiling_dbfs: f32,
    pub limiter_release_ms: f32,
}

impl Default for VocalDynamicsConfig {
    fn default() -> Self {
        Self {
            high_pass_hz: 80.0,
            presence_hz: 3_200.0,
            presence_gain_db: 1.5,
            deesser_hz: 5_800.0,
            deesser_threshold_dbfs: -24.0,
            deesser_ratio: 4.0,
            compressor_threshold_dbfs: -18.0,
            compressor_ratio: 3.0,
            compressor_attack_ms: 10.0,
            compressor_release_ms: 90.0,
            makeup_gain_db: 2.0,
            limiter_ceiling_dbfs: -1.0,
            limiter_release_ms: 80.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct VocalDynamicsMetrics {
    pub processed_samples: u64,
    pub deesser_active_samples: u64,
    pub compressor_active_samples: u64,
    pub limiter_active_samples: u64,
    pub maximum_deesser_reduction_db: f32,
    pub maximum_compressor_reduction_db: f32,
    pub maximum_limiter_reduction_db: f32,
    pub maximum_absolute_output: f32,
    pub invalid_fallback_samples: u64,
}

/// Fixed-state vocal channel strip. Construction calculates all coefficients;
/// `process_block` performs no allocation, locking or I/O.
pub struct VocalDynamicsProcessor {
    config: VocalDynamicsConfig,
    high_pass: Biquad,
    presence: Biquad,
    deesser_low: f32,
    deesser_envelope: f32,
    compressor_envelope: f32,
    compressor_gain: f32,
    limiter_gain: f32,
    metrics: VocalDynamicsMetrics,
}

impl VocalDynamicsProcessor {
    pub fn new(config: VocalDynamicsConfig) -> Result<Self, EngineError> {
        validate(&config)?;
        Ok(Self {
            high_pass: Biquad::high_pass(config.high_pass_hz, 0.707)?,
            presence: Biquad::peaking(config.presence_hz, 0.8, config.presence_gain_db)?,
            config,
            deesser_low: 0.0,
            deesser_envelope: 0.0,
            compressor_envelope: 0.0,
            compressor_gain: 1.0,
            limiter_gain: 1.0,
            metrics: VocalDynamicsMetrics::default(),
        })
    }

    pub fn metrics(&self) -> VocalDynamicsMetrics {
        self.metrics
    }

    pub fn process_block(&mut self, input: &[f32], output: &mut [f32]) {
        debug_assert_eq!(input.len(), output.len());
        let deesser_low_alpha = one_pole_alpha(self.config.deesser_hz);
        let deesser_attack = time_alpha(2.0);
        let deesser_release = time_alpha(55.0);
        let compressor_attack = time_alpha(self.config.compressor_attack_ms);
        let compressor_release = time_alpha(self.config.compressor_release_ms);
        let limiter_release = time_alpha(self.config.limiter_release_ms);
        let makeup = db_to_gain(self.config.makeup_gain_db);
        let ceiling = db_to_gain(self.config.limiter_ceiling_dbfs);

        for (source, destination) in input.iter().zip(output) {
            let dry = if source.is_finite() {
                source.clamp(-1.0, 1.0)
            } else {
                self.metrics.invalid_fallback_samples += 1;
                0.0
            };
            let equalized = self.presence.process(self.high_pass.process(dry));

            self.deesser_low += deesser_low_alpha * (equalized - self.deesser_low);
            let high_band = equalized - self.deesser_low;
            self.deesser_envelope = follow_envelope(
                self.deesser_envelope,
                high_band.abs(),
                deesser_attack,
                deesser_release,
            );
            let deesser_reduction = downward_reduction_db(
                self.deesser_envelope,
                self.config.deesser_threshold_dbfs,
                self.config.deesser_ratio,
            );
            if deesser_reduction > 0.01 {
                self.metrics.deesser_active_samples += 1;
                self.metrics.maximum_deesser_reduction_db = self
                    .metrics
                    .maximum_deesser_reduction_db
                    .max(deesser_reduction);
            }
            let deessed = self.deesser_low + high_band * db_to_gain(-deesser_reduction);

            self.compressor_envelope = follow_envelope(
                self.compressor_envelope,
                deessed.abs(),
                compressor_attack,
                compressor_release,
            );
            let compressor_reduction = downward_reduction_db(
                self.compressor_envelope,
                self.config.compressor_threshold_dbfs,
                self.config.compressor_ratio,
            );
            if compressor_reduction > 0.01 {
                self.metrics.compressor_active_samples += 1;
                self.metrics.maximum_compressor_reduction_db = self
                    .metrics
                    .maximum_compressor_reduction_db
                    .max(compressor_reduction);
            }
            let compressor_target = db_to_gain(-compressor_reduction);
            let compressor_alpha = if compressor_target < self.compressor_gain {
                compressor_attack
            } else {
                compressor_release
            };
            self.compressor_gain += compressor_alpha * (compressor_target - self.compressor_gain);
            let compressed = deessed * self.compressor_gain * makeup;

            let limiter_target = if compressed.abs() > ceiling {
                ceiling / compressed.abs().max(1.0e-12)
            } else {
                1.0
            };
            if limiter_target < self.limiter_gain {
                self.limiter_gain = limiter_target;
            } else {
                self.limiter_gain += limiter_release * (1.0 - self.limiter_gain);
            }
            let limiter_reduction = -gain_to_db(self.limiter_gain).min(0.0);
            if limiter_reduction > 0.01 {
                self.metrics.limiter_active_samples += 1;
                self.metrics.maximum_limiter_reduction_db = self
                    .metrics
                    .maximum_limiter_reduction_db
                    .max(limiter_reduction);
            }
            let candidate = compressed * self.limiter_gain;
            let safe = if candidate.is_finite() {
                candidate.clamp(-ceiling, ceiling)
            } else {
                self.metrics.invalid_fallback_samples += 1;
                dry.clamp(-ceiling, ceiling)
            };
            *destination = safe;
            self.metrics.processed_samples += 1;
            self.metrics.maximum_absolute_output =
                self.metrics.maximum_absolute_output.max(safe.abs());
        }
    }
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn high_pass(frequency: f32, q: f32) -> Result<Self, EngineError> {
        let omega = 2.0 * std::f32::consts::PI * frequency / SAMPLE_RATE as f32;
        let cosine = omega.cos();
        let alpha = omega.sin() / (2.0 * q);
        Self::normalized(
            (1.0 + cosine) * 0.5,
            -(1.0 + cosine),
            (1.0 + cosine) * 0.5,
            1.0 + alpha,
            -2.0 * cosine,
            1.0 - alpha,
        )
    }

    fn peaking(frequency: f32, q: f32, gain_db: f32) -> Result<Self, EngineError> {
        let amplitude = 10.0_f32.powf(gain_db / 40.0);
        let omega = 2.0 * std::f32::consts::PI * frequency / SAMPLE_RATE as f32;
        let alpha = omega.sin() / (2.0 * q);
        Self::normalized(
            1.0 + alpha * amplitude,
            -2.0 * omega.cos(),
            1.0 - alpha * amplitude,
            1.0 + alpha / amplitude,
            -2.0 * omega.cos(),
            1.0 - alpha / amplitude,
        )
    }

    fn normalized(
        b0: f32,
        b1: f32,
        b2: f32,
        a0: f32,
        a1: f32,
        a2: f32,
    ) -> Result<Self, EngineError> {
        if !a0.is_finite() || a0.abs() < 1.0e-9 {
            return Err(EngineError("Dynamics biquad 系数无效".into()));
        }
        Ok(Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        })
    }

    fn process(&mut self, sample: f32) -> f32 {
        let output = self.b0 * sample + self.z1;
        self.z1 = self.b1 * sample - self.a1 * output + self.z2;
        self.z2 = self.b2 * sample - self.a2 * output;
        output
    }
}

fn validate(config: &VocalDynamicsConfig) -> Result<(), EngineError> {
    let valid = (20.0..=300.0).contains(&config.high_pass_hz)
        && (500.0..=10_000.0).contains(&config.presence_hz)
        && (-6.0..=6.0).contains(&config.presence_gain_db)
        && (2_000.0..=12_000.0).contains(&config.deesser_hz)
        && (-60.0..=-6.0).contains(&config.deesser_threshold_dbfs)
        && (1.0..=20.0).contains(&config.deesser_ratio)
        && (-60.0..=-3.0).contains(&config.compressor_threshold_dbfs)
        && (1.0..=20.0).contains(&config.compressor_ratio)
        && (0.1..=100.0).contains(&config.compressor_attack_ms)
        && (5.0..=1_000.0).contains(&config.compressor_release_ms)
        && (-6.0..=12.0).contains(&config.makeup_gain_db)
        && (-12.0..=-0.1).contains(&config.limiter_ceiling_dbfs)
        && (5.0..=1_000.0).contains(&config.limiter_release_ms);
    if !valid {
        return Err(EngineError("Vocal dynamics 配置无效".into()));
    }
    Ok(())
}

fn one_pole_alpha(frequency: f32) -> f32 {
    1.0 - (-2.0 * std::f32::consts::PI * frequency / SAMPLE_RATE as f32).exp()
}

fn time_alpha(milliseconds: f32) -> f32 {
    1.0 - (-1.0 / (milliseconds * 0.001 * SAMPLE_RATE as f32)).exp()
}

fn follow_envelope(current: f32, target: f32, attack: f32, release: f32) -> f32 {
    let alpha = if target > current { attack } else { release };
    current + alpha * (target - current)
}

fn downward_reduction_db(envelope: f32, threshold_dbfs: f32, ratio: f32) -> f32 {
    let level_db = gain_to_db(envelope);
    let above = (level_db - threshold_dbfs).max(0.0);
    above * (1.0 - 1.0 / ratio)
}

fn db_to_gain(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

fn gain_to_db(gain: f32) -> f32 {
    20.0 * gain.max(1.0e-12).log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frequency: f32, amplitude: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|frame| {
                amplitude
                    * (2.0 * std::f32::consts::PI * frequency * frame as f32 / SAMPLE_RATE as f32)
                        .sin()
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn high_pass_rejects_sub_bass_more_than_voice() {
        let mut low_processor =
            VocalDynamicsProcessor::new(VocalDynamicsConfig::default()).unwrap();
        let mut voice_processor =
            VocalDynamicsProcessor::new(VocalDynamicsConfig::default()).unwrap();
        let low = sine(30.0, 0.05, SAMPLE_RATE as usize);
        let voice = sine(500.0, 0.05, SAMPLE_RATE as usize);
        let mut low_output = vec![0.0; low.len()];
        let mut voice_output = vec![0.0; voice.len()];
        low_processor.process_block(&low, &mut low_output);
        voice_processor.process_block(&voice, &mut voice_output);
        assert!(rms(&low_output[24_000..]) < rms(&voice_output[24_000..]) * 0.3);
    }

    #[test]
    fn loud_voice_activates_compressor_and_limiter_stays_bounded() {
        let mut processor = VocalDynamicsProcessor::new(VocalDynamicsConfig::default()).unwrap();
        let input = sine(1_000.0, 0.95, SAMPLE_RATE as usize);
        let mut output = vec![0.0; input.len()];
        processor.process_block(&input, &mut output);
        let metrics = processor.metrics();
        assert!(metrics.compressor_active_samples > 0);
        assert!(metrics.limiter_active_samples > 0);
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert!(metrics.maximum_absolute_output <= db_to_gain(-1.0) + 1.0e-6);
    }

    #[test]
    fn sibilance_activates_deesser() {
        let mut processor = VocalDynamicsProcessor::new(VocalDynamicsConfig::default()).unwrap();
        let input = sine(8_000.0, 0.4, SAMPLE_RATE as usize / 2);
        let mut output = vec![0.0; input.len()];
        processor.process_block(&input, &mut output);
        let metrics = processor.metrics();
        assert!(metrics.deesser_active_samples > 0);
        assert!(metrics.maximum_deesser_reduction_db > 1.0);
    }

    #[test]
    fn invalid_input_never_reaches_output() {
        let mut processor = VocalDynamicsProcessor::new(VocalDynamicsConfig::default()).unwrap();
        let input = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0];
        let mut output = [0.0; 4];
        processor.process_block(&input, &mut output);
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert_eq!(processor.metrics().invalid_fallback_samples, 3);
    }
}
