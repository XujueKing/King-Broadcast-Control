use crate::{EngineError, SAMPLE_RATE};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct PitchTrackerConfig {
    pub min_hz: f32,
    pub max_hz: f32,
    pub window_frames: usize,
    pub hop_frames: usize,
    pub downsample_factor: usize,
    pub rms_gate_dbfs: f32,
    pub correlation_threshold: f32,
}

impl Default for PitchTrackerConfig {
    fn default() -> Self {
        Self {
            min_hz: 70.0,
            max_hz: 1_000.0,
            window_frames: 2_048,
            hop_frames: 128,
            downsample_factor: 4,
            rms_gate_dbfs: -55.0,
            correlation_threshold: 0.68,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchObservation {
    pub sample_position: u64,
    pub time_seconds: f64,
    pub voiced: bool,
    pub f0_hz: Option<f32>,
    pub confidence: f32,
    pub rms_dbfs: f32,
}

pub struct PitchTracker {
    config: PitchTrackerConfig,
    downsampled_rate: f32,
    ring: Vec<f32>,
    analysis: Vec<f32>,
    correlations: Vec<f32>,
    write_index: usize,
    filled: usize,
    hop_downsampled: usize,
    since_analysis: usize,
    downsample_sum: f32,
    downsample_count: usize,
    samples_seen: u64,
}

pub fn cents_between(measured_hz: f32, target_hz: f32) -> Option<f32> {
    if !measured_hz.is_finite() || !target_hz.is_finite() || measured_hz <= 0.0 || target_hz <= 0.0
    {
        return None;
    }
    Some(1_200.0 * (measured_hz / target_hz).log2())
}

impl PitchTracker {
    pub fn new(config: PitchTrackerConfig) -> Result<Self, EngineError> {
        validate(&config)?;
        let window_downsampled = config.window_frames / config.downsample_factor;
        let downsampled_rate = SAMPLE_RATE as f32 / config.downsample_factor as f32;
        let max_lag = (downsampled_rate / config.min_hz).ceil() as usize + 2;
        let hop_downsampled = config.hop_frames / config.downsample_factor;
        Ok(Self {
            config,
            downsampled_rate,
            ring: vec![0.0; window_downsampled],
            analysis: vec![0.0; window_downsampled],
            correlations: vec![0.0; max_lag + 1],
            write_index: 0,
            filled: 0,
            hop_downsampled,
            since_analysis: 0,
            downsample_sum: 0.0,
            downsample_count: 0,
            samples_seen: 0,
        })
    }

    pub fn process_block(&mut self, samples: &[f32]) -> Option<PitchObservation> {
        let mut latest = None;
        for sample in samples {
            self.samples_seen += 1;
            self.downsample_sum += *sample;
            self.downsample_count += 1;
            if self.downsample_count != self.config.downsample_factor {
                continue;
            }
            let downsampled = self.downsample_sum / self.config.downsample_factor as f32;
            self.downsample_sum = 0.0;
            self.downsample_count = 0;
            self.ring[self.write_index] = downsampled;
            self.write_index = (self.write_index + 1) % self.ring.len();
            self.filled = (self.filled + 1).min(self.ring.len());
            self.since_analysis += 1;
            if self.filled == self.ring.len() && self.since_analysis >= self.hop_downsampled {
                self.since_analysis = 0;
                latest = Some(self.analyze());
            }
        }
        latest
    }

    fn analyze(&mut self) -> PitchObservation {
        for index in 0..self.ring.len() {
            self.analysis[index] = self.ring[(self.write_index + index) % self.ring.len()];
        }
        let mean = self.analysis.iter().sum::<f32>() / self.analysis.len() as f32;
        let mut energy = 0.0_f32;
        for sample in &mut self.analysis {
            *sample -= mean;
            energy += *sample * *sample;
        }
        let rms = (energy / self.analysis.len() as f32).sqrt();
        let rms_dbfs = 20.0 * rms.max(1.0e-12).log10();
        let sample_position = self.samples_seen.saturating_sub(
            (self.config.window_frames / 2)
                .try_into()
                .unwrap_or(u64::MAX),
        );
        if rms_dbfs < self.config.rms_gate_dbfs {
            return PitchObservation {
                sample_position,
                time_seconds: sample_position as f64 / SAMPLE_RATE as f64,
                voiced: false,
                f0_hz: None,
                confidence: 0.0,
                rms_dbfs,
            };
        }

        let min_lag = (self.downsampled_rate / self.config.max_hz).floor() as usize;
        let max_lag = ((self.downsampled_rate / self.config.min_hz).ceil() as usize)
            .min(self.analysis.len() - 2)
            .min(self.correlations.len() - 2);
        let mut global_peak = 0.0_f32;
        for lag in min_lag..=max_lag {
            let count = self.analysis.len() - lag;
            let mut dot = 0.0_f32;
            let mut left_energy = 0.0_f32;
            let mut right_energy = 0.0_f32;
            for index in 0..count {
                let left = self.analysis[index];
                let right = self.analysis[index + lag];
                dot += left * right;
                left_energy += left * left;
                right_energy += right * right;
            }
            let denominator = (left_energy * right_energy).sqrt().max(1.0e-12);
            let correlation = (dot / denominator).clamp(-1.0, 1.0);
            self.correlations[lag] = correlation;
            global_peak = global_peak.max(correlation);
        }

        let required = self.config.correlation_threshold.max(global_peak * 0.9);
        let mut peak_lag = None;
        for lag in (min_lag + 1)..max_lag {
            if self.correlations[lag] >= required
                && self.correlations[lag] >= self.correlations[lag - 1]
                && self.correlations[lag] > self.correlations[lag + 1]
            {
                peak_lag = Some(lag);
                break;
            }
        }
        let Some(lag) = peak_lag else {
            return PitchObservation {
                sample_position,
                time_seconds: sample_position as f64 / SAMPLE_RATE as f64,
                voiced: false,
                f0_hz: None,
                confidence: global_peak.max(0.0),
                rms_dbfs,
            };
        };
        let left = self.correlations[lag - 1];
        let center = self.correlations[lag];
        let right = self.correlations[lag + 1];
        let denominator = left - 2.0 * center + right;
        let offset = if denominator.abs() < 1.0e-9 {
            0.0
        } else {
            (0.5 * (left - right) / denominator).clamp(-1.0, 1.0)
        };
        let refined_lag = lag as f32 + offset;
        PitchObservation {
            sample_position,
            time_seconds: sample_position as f64 / SAMPLE_RATE as f64,
            voiced: true,
            f0_hz: Some(self.downsampled_rate / refined_lag),
            confidence: center.max(0.0),
            rms_dbfs,
        }
    }
}

fn validate(config: &PitchTrackerConfig) -> Result<(), EngineError> {
    if !(40.0..=300.0).contains(&config.min_hz)
        || !(300.0..=2_000.0).contains(&config.max_hz)
        || config.min_hz >= config.max_hz
    {
        return Err(EngineError("F0 范围无效".into()));
    }
    if config.downsample_factor == 0
        || config.window_frames < 512
        || config.window_frames % config.downsample_factor != 0
        || config.hop_frames == 0
        || config.hop_frames % config.downsample_factor != 0
    {
        return Err(EngineError("F0 window/hop/downsample 配置无效".into()));
    }
    if !(0.0..=1.0).contains(&config.correlation_threshold) {
        return Err(EngineError("F0 correlation threshold 无效".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    fn observations_for(samples: &[f32]) -> Vec<PitchObservation> {
        let mut tracker = PitchTracker::new(PitchTrackerConfig::default()).unwrap();
        samples
            .chunks(128)
            .filter_map(|block| tracker.process_block(block))
            .collect()
    }

    #[test]
    fn tracks_a4_with_sub_hertz_accuracy() {
        let samples = (0..SAMPLE_RATE as usize)
            .map(|index| 0.3 * (TAU * 440.0 * index as f32 / SAMPLE_RATE as f32).sin())
            .collect::<Vec<_>>();
        let observations = observations_for(&samples);
        let voiced = observations
            .iter()
            .filter_map(|observation| observation.f0_hz)
            .collect::<Vec<_>>();
        assert!(!voiced.is_empty());
        let mean = voiced.iter().sum::<f32>() / voiced.len() as f32;
        assert!((mean - 440.0).abs() < 1.0, "mean F0 was {mean}");
    }

    #[test]
    fn silence_is_not_reported_as_a_voice() {
        let samples = vec![0.0; SAMPLE_RATE as usize / 2];
        let observations = observations_for(&samples);
        assert!(!observations.is_empty());
        assert!(observations.iter().all(|observation| !observation.voiced));
    }

    #[test]
    fn follows_singing_vibrato_without_octave_jumps() {
        let mut phase = 0.0_f32;
        let samples = (0..SAMPLE_RATE as usize)
            .map(|index| {
                let time = index as f32 / SAMPLE_RATE as f32;
                let frequency = 220.0 + 6.0 * (TAU * 5.0 * time).sin();
                phase += TAU * frequency / SAMPLE_RATE as f32;
                0.28 * phase.sin() + 0.08 * (2.0 * phase).sin()
            })
            .collect::<Vec<_>>();
        let observations = observations_for(&samples);
        let voiced = observations
            .iter()
            .filter_map(|observation| observation.f0_hz)
            .collect::<Vec<_>>();
        assert!(!voiced.is_empty());
        assert!(voiced.iter().all(|f0| (190.0..250.0).contains(f0)));
    }

    #[test]
    fn cents_error_is_signed_and_rejects_invalid_frequency() {
        let above = 440.0 * 2.0_f32.powf(50.0 / 1_200.0);
        let below = 440.0 * 2.0_f32.powf(-25.0 / 1_200.0);
        assert!((cents_between(above, 440.0).unwrap() - 50.0).abs() < 0.001);
        assert!((cents_between(below, 440.0).unwrap() + 25.0).abs() < 0.001);
        assert_eq!(cents_between(0.0, 440.0), None);
    }
}
