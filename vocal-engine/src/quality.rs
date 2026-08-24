use crate::{
    correction::ReferenceTarget,
    pitch::{cents_between, PitchObservation},
    EngineError,
};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct VocalQualityConfig {
    pub preserve_threshold: f32,
    pub gentle_threshold: f32,
    pub strong_threshold: f32,
    pub smoothing_attack_ms: f32,
    pub smoothing_release_ms: f32,
    pub hop_frames: usize,
}

impl Default for VocalQualityConfig {
    fn default() -> Self {
        Self {
            preserve_threshold: 85.0,
            gentle_threshold: 65.0,
            strong_threshold: 40.0,
            smoothing_attack_ms: 120.0,
            smoothing_release_ms: 45.0,
            hop_frames: 128,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VocalQualityClass {
    Preserve,
    GentleCorrection,
    StrongCorrection,
    RepairCandidate,
}

impl VocalQualityClass {
    pub const fn code(self) -> u64 {
        match self {
            Self::Preserve => 0,
            Self::GentleCorrection => 1,
            Self::StrongCorrection => 2,
            Self::RepairCandidate => 3,
        }
    }

    pub const fn from_code(code: u64) -> Self {
        match code {
            0 => Self::Preserve,
            1 => Self::GentleCorrection,
            2 => Self::StrongCorrection,
            _ => Self::RepairCandidate,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalQualityObservation {
    pub sample_position: u64,
    pub time_seconds: f64,
    pub pitch_score: f32,
    pub timing_score: f32,
    pub stability_score: f32,
    pub voicing_score: f32,
    pub energy_score: f32,
    pub confidence_score: f32,
    pub instantaneous_quality_score: f32,
    pub quality_score: f32,
    pub quality_class: VocalQualityClass,
    pub reference_expected_voice: Option<bool>,
}

pub struct VocalQualityScorer {
    config: VocalQualityConfig,
    smoothed_score: f32,
    initialized: bool,
    previous_target_midi: Option<u8>,
    smoothed_pitch_error: f32,
}

impl VocalQualityScorer {
    pub fn new(config: VocalQualityConfig) -> Result<Self, EngineError> {
        validate(&config)?;
        Ok(Self {
            config,
            smoothed_score: 0.0,
            initialized: false,
            previous_target_midi: None,
            smoothed_pitch_error: 0.0,
        })
    }

    pub fn process(
        &mut self,
        observation: PitchObservation,
        reference: Option<ReferenceTarget>,
        reference_available: bool,
    ) -> VocalQualityObservation {
        let measured = observation
            .f0_hz
            .filter(|frequency| observation.voiced && frequency.is_finite() && *frequency > 0.0);
        let target = reference.or_else(|| measured.map(nearest_chromatic_target));
        let pitch_error = measured
            .zip(target)
            .and_then(|(frequency, target)| cents_between(frequency, target.target_hz));
        let mut pitch_score = pitch_error
            .map(|error| score_falling(error.abs(), 8.0, 110.0))
            .unwrap_or_else(|| if reference.is_some() { 0.0 } else { 50.0 });

        let target_changed = target
            .map(|value| Some(value.midi_note) != self.previous_target_midi)
            .unwrap_or(false);
        let mut stability_score = if let Some(error) = pitch_error {
            if target_changed || !self.initialized {
                self.smoothed_pitch_error = error;
                100.0
            } else {
                self.smoothed_pitch_error += 0.12 * (error - self.smoothed_pitch_error);
                score_falling((error - self.smoothed_pitch_error).abs(), 4.0, 55.0)
            }
        } else {
            25.0
        };
        self.previous_target_midi = target.map(|value| value.midi_note);

        let expected_voice = reference_available.then_some(reference.is_some());
        let timing_score = match expected_voice {
            Some(expected) if expected == observation.voiced => 100.0,
            Some(true) => 0.0,
            Some(false) => 30.0,
            None => 75.0,
        };
        let voicing_score = match expected_voice {
            Some(true) if observation.voiced => 100.0,
            Some(true) => 0.0,
            Some(false) if observation.voiced => 35.0,
            Some(false) => 100.0,
            None if observation.voiced => 100.0,
            None => 50.0,
        };
        let energy_score = if expected_voice == Some(false) && !observation.voiced {
            100.0
        } else {
            energy_score(observation.rms_dbfs)
        };
        let mut confidence_score = (observation.confidence * 100.0).clamp(0.0, 100.0);
        if expected_voice == Some(false) && !observation.voiced {
            pitch_score = 100.0;
            stability_score = 100.0;
            confidence_score = 100.0;
        }
        let instantaneous = (pitch_score * 0.45
            + timing_score * 0.15
            + stability_score * 0.15
            + voicing_score * 0.10
            + energy_score * 0.075
            + confidence_score * 0.075)
            .clamp(0.0, 100.0);
        if !self.initialized {
            self.smoothed_score = instantaneous;
            self.initialized = true;
        } else {
            let milliseconds = if instantaneous < self.smoothed_score {
                self.config.smoothing_release_ms
            } else {
                self.config.smoothing_attack_ms
            };
            let hop_ms = self.config.hop_frames as f32 / crate::SAMPLE_RATE as f32 * 1_000.0;
            let alpha = 1.0 - (-hop_ms / milliseconds).exp();
            self.smoothed_score += alpha * (instantaneous - self.smoothed_score);
        }
        let quality_score = self.smoothed_score.clamp(0.0, 100.0);
        VocalQualityObservation {
            sample_position: observation.sample_position,
            time_seconds: observation.time_seconds,
            pitch_score,
            timing_score,
            stability_score,
            voicing_score,
            energy_score,
            confidence_score,
            instantaneous_quality_score: instantaneous,
            quality_score,
            quality_class: self.classify(quality_score),
            reference_expected_voice: expected_voice,
        }
    }

    fn classify(&self, score: f32) -> VocalQualityClass {
        if score >= self.config.preserve_threshold {
            VocalQualityClass::Preserve
        } else if score >= self.config.gentle_threshold {
            VocalQualityClass::GentleCorrection
        } else if score >= self.config.strong_threshold {
            VocalQualityClass::StrongCorrection
        } else {
            VocalQualityClass::RepairCandidate
        }
    }
}

fn validate(config: &VocalQualityConfig) -> Result<(), EngineError> {
    if config.hop_frames == 0
        || !(0.0..=100.0).contains(&config.strong_threshold)
        || !(config.strong_threshold..=100.0).contains(&config.gentle_threshold)
        || !(config.gentle_threshold..=100.0).contains(&config.preserve_threshold)
        || !(1.0..=2_000.0).contains(&config.smoothing_attack_ms)
        || !(1.0..=2_000.0).contains(&config.smoothing_release_ms)
    {
        return Err(EngineError("Vocal Quality 配置无效".into()));
    }
    Ok(())
}

fn nearest_chromatic_target(frequency: f32) -> ReferenceTarget {
    let midi = (69.0 + 12.0 * (frequency / 440.0).log2())
        .round()
        .clamp(0.0, 127.0) as u8;
    ReferenceTarget {
        midi_note: midi,
        target_hz: 440.0 * 2.0_f32.powf((midi as f32 - 69.0) / 12.0),
    }
}

fn score_falling(value: f32, full_score_until: f32, zero_score_at: f32) -> f32 {
    if value <= full_score_until {
        100.0
    } else {
        (100.0 * (zero_score_at - value) / (zero_score_at - full_score_until)).clamp(0.0, 100.0)
    }
}

fn energy_score(dbfs: f32) -> f32 {
    if !dbfs.is_finite() || dbfs <= -60.0 {
        return 0.0;
    }
    if (-30.0..=-9.0).contains(&dbfs) {
        100.0
    } else if dbfs < -30.0 {
        score_falling(-dbfs, 30.0, 60.0)
    } else {
        score_falling(dbfs + 30.0, 21.0, 30.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(frequency: Option<f32>, confidence: f32, dbfs: f32) -> PitchObservation {
        PitchObservation {
            sample_position: 4096,
            time_seconds: 4096.0 / crate::SAMPLE_RATE as f64,
            voiced: frequency.is_some(),
            f0_hz: frequency,
            confidence,
            rms_dbfs: dbfs,
        }
    }

    fn target(midi: u8) -> ReferenceTarget {
        ReferenceTarget {
            midi_note: midi,
            target_hz: 440.0 * 2.0_f32.powf((midi as f32 - 69.0) / 12.0),
        }
    }

    #[test]
    fn accurate_confident_voice_is_preserved() {
        let mut scorer = VocalQualityScorer::new(VocalQualityConfig::default()).unwrap();
        let result = scorer.process(
            observation(Some(440.0), 0.99, -18.0),
            Some(target(69)),
            true,
        );
        assert!(result.quality_score >= 95.0);
        assert_eq!(result.quality_class, VocalQualityClass::Preserve);
    }

    #[test]
    fn a_full_semitone_error_is_not_scored_as_good() {
        let mut scorer = VocalQualityScorer::new(VocalQualityConfig::default()).unwrap();
        let result = scorer.process(
            observation(Some(466.163_76), 0.99, -18.0),
            Some(target(69)),
            true,
        );
        assert!(result.pitch_score < 10.0);
        assert!(result.quality_score < 70.0);
    }

    #[test]
    fn missing_an_expected_word_penalizes_timing_and_voicing() {
        let mut scorer = VocalQualityScorer::new(VocalQualityConfig::default()).unwrap();
        let result = scorer.process(observation(None, 0.0, -90.0), Some(target(69)), true);
        assert_eq!(result.timing_score, 0.0);
        assert_eq!(result.voicing_score, 0.0);
        assert_eq!(result.energy_score, 0.0);
        assert_eq!(result.quality_class, VocalQualityClass::RepairCandidate);
    }

    #[test]
    fn silence_in_a_reference_gap_is_not_a_bad_performance() {
        let mut scorer = VocalQualityScorer::new(VocalQualityConfig::default()).unwrap();
        let result = scorer.process(observation(None, 0.0, -90.0), None, true);
        assert_eq!(result.timing_score, 100.0);
        assert_eq!(result.voicing_score, 100.0);
        assert_eq!(result.energy_score, 100.0);
        assert_eq!(result.quality_score, 100.0);
    }
}
