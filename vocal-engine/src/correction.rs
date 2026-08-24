use crate::{pitch::PitchObservation, EngineError, SAMPLE_RATE};
use serde::Serialize;
use std::str::FromStr;

pub const CHROMATIC_MASK: u16 = 0x0fff;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScaleMode {
    Major,
    NaturalMinor,
}

impl FromStr for ScaleMode {
    type Err = EngineError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "major" | "maj" => Ok(Self::Major),
            "minor" | "natural-minor" | "min" => Ok(Self::NaturalMinor),
            _ => Err(EngineError(format!("未知调式 {value}；可选 major/minor"))),
        }
    }
}

pub fn parse_tonic(value: &str) -> Result<u8, EngineError> {
    match value.trim().to_ascii_uppercase().as_str() {
        "C" => Ok(0),
        "C#" | "DB" => Ok(1),
        "D" => Ok(2),
        "D#" | "EB" => Ok(3),
        "E" | "FB" => Ok(4),
        "F" | "E#" => Ok(5),
        "F#" | "GB" => Ok(6),
        "G" => Ok(7),
        "G#" | "AB" => Ok(8),
        "A" => Ok(9),
        "A#" | "BB" => Ok(10),
        "B" | "CB" => Ok(11),
        _ => Err(EngineError(format!("未知主音 {value}"))),
    }
}

pub fn scale_mask(tonic: u8, mode: ScaleMode) -> u16 {
    let intervals: &[u8] = match mode {
        ScaleMode::Major => &[0, 2, 4, 5, 7, 9, 11],
        ScaleMode::NaturalMinor => &[0, 2, 3, 5, 7, 8, 10],
    };
    intervals.iter().fold(0_u16, |mask, interval| {
        mask | 1 << ((tonic + interval) % 12)
    })
}

#[derive(Clone, Copy, Debug)]
pub struct ReferenceTarget {
    pub midi_note: u8,
    pub target_hz: f32,
}

#[derive(Clone, Debug)]
pub struct CorrectionPlannerConfig {
    pub hop_frames: usize,
    pub minimum_confidence: f32,
    pub strength: f32,
    pub deadband_cents: f32,
    pub maximum_correction_cents: f32,
    pub target_hysteresis_cents: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub reset_target_after_ms: f32,
    pub allowed_pitch_classes: u16,
}

impl Default for CorrectionPlannerConfig {
    fn default() -> Self {
        Self {
            hop_frames: 128,
            minimum_confidence: 0.72,
            strength: 0.75,
            deadband_cents: 8.0,
            maximum_correction_cents: 45.0,
            target_hysteresis_cents: 12.0,
            attack_ms: 18.0,
            release_ms: 55.0,
            reset_target_after_ms: 180.0,
            allowed_pitch_classes: CHROMATIC_MASK,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CorrectionState {
    Active,
    Deadband,
    Unvoiced,
    LowConfidence,
    InvalidPitch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetSource {
    None,
    Chromatic,
    Scale,
    Reference,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionDecision {
    pub sample_position: u64,
    pub time_seconds: f64,
    pub state: CorrectionState,
    pub measured_f0_hz: Option<f32>,
    pub target_midi: Option<u8>,
    pub target_hz: Option<f32>,
    pub cents_error: Option<f32>,
    pub desired_correction_cents: f32,
    pub applied_correction_cents: f32,
    pub correction_percent: f32,
    pub confidence: f32,
    pub target_source: TargetSource,
}

pub struct CorrectionPlanner {
    config: CorrectionPlannerConfig,
    target_midi: Option<u8>,
    applied_cents: f32,
    unvoiced_hops: usize,
    reset_hops: usize,
}

impl CorrectionPlanner {
    pub fn new(config: CorrectionPlannerConfig) -> Result<Self, EngineError> {
        validate(&config)?;
        let hop_ms = config.hop_frames as f32 / SAMPLE_RATE as f32 * 1_000.0;
        let reset_hops = (config.reset_target_after_ms / hop_ms).ceil() as usize;
        Ok(Self {
            config,
            target_midi: None,
            applied_cents: 0.0,
            unvoiced_hops: 0,
            reset_hops,
        })
    }

    pub fn set_runtime_controls(
        &mut self,
        strength: f32,
        deadband_cents: f32,
        maximum_correction_cents: f32,
    ) {
        if strength.is_finite()
            && deadband_cents.is_finite()
            && maximum_correction_cents.is_finite()
        {
            self.config.strength = strength.clamp(0.0, 1.0);
            self.config.deadband_cents = deadband_cents.clamp(0.0, 50.0);
            self.config.maximum_correction_cents = maximum_correction_cents.clamp(1.0, 200.0);
        }
    }

    pub fn process(&mut self, observation: PitchObservation) -> CorrectionDecision {
        self.process_with_reference(observation, None)
    }

    pub fn process_with_reference(
        &mut self,
        observation: PitchObservation,
        reference: Option<ReferenceTarget>,
    ) -> CorrectionDecision {
        if !observation.voiced {
            return self.bypass(observation, CorrectionState::Unvoiced);
        }
        if observation.confidence < self.config.minimum_confidence {
            return self.bypass(observation, CorrectionState::LowConfidence);
        }
        let Some(f0_hz) = observation
            .f0_hz
            .filter(|value| value.is_finite() && *value > 0.0)
        else {
            return self.bypass(observation, CorrectionState::InvalidPitch);
        };

        self.unvoiced_hops = 0;
        let measured_midi = 69.0 + 12.0 * (f0_hz / 440.0).log2();
        let nearest = nearest_allowed_midi(measured_midi, self.config.allowed_pitch_classes);
        let (target_midi, target_hz, target_source) = if let Some(reference) = reference {
            (
                reference.midi_note,
                reference.target_hz,
                TargetSource::Reference,
            )
        } else {
            let selected = match self.target_midi {
                Some(current)
                    if pitch_class_allowed(current, self.config.allowed_pitch_classes)
                        && (measured_midi - current as f32).abs()
                            <= 0.5 + self.config.target_hysteresis_cents / 100.0 =>
                {
                    current
                }
                _ => nearest,
            };
            (
                selected,
                midi_to_hz(selected),
                if self.config.allowed_pitch_classes == CHROMATIC_MASK {
                    TargetSource::Chromatic
                } else {
                    TargetSource::Scale
                },
            )
        };
        self.target_midi = Some(target_midi);
        let cents_error = 1_200.0 * (f0_hz / target_hz).log2();
        let outside_deadband = (cents_error.abs() - self.config.deadband_cents).max(0.0);
        let desired = (-cents_error.signum() * outside_deadband * self.config.strength).clamp(
            -self.config.maximum_correction_cents,
            self.config.maximum_correction_cents,
        );
        let state = if outside_deadband == 0.0 {
            CorrectionState::Deadband
        } else {
            CorrectionState::Active
        };
        self.applied_cents = smooth(
            self.applied_cents,
            desired,
            self.config.hop_frames,
            if desired.abs() > self.applied_cents.abs() {
                self.config.attack_ms
            } else {
                self.config.release_ms
            },
        );
        CorrectionDecision {
            sample_position: observation.sample_position,
            time_seconds: observation.time_seconds,
            state,
            measured_f0_hz: Some(f0_hz),
            target_midi: Some(target_midi),
            target_hz: Some(target_hz),
            cents_error: Some(cents_error),
            desired_correction_cents: desired,
            applied_correction_cents: self.applied_cents,
            correction_percent: (self.applied_cents.abs() / self.config.maximum_correction_cents
                * 100.0)
                .clamp(0.0, 100.0),
            confidence: observation.confidence,
            target_source,
        }
    }

    fn bypass(
        &mut self,
        observation: PitchObservation,
        state: CorrectionState,
    ) -> CorrectionDecision {
        self.unvoiced_hops += 1;
        if self.unvoiced_hops >= self.reset_hops {
            self.target_midi = None;
        }
        self.applied_cents = smooth(
            self.applied_cents,
            0.0,
            self.config.hop_frames,
            self.config.release_ms,
        );
        CorrectionDecision {
            sample_position: observation.sample_position,
            time_seconds: observation.time_seconds,
            state,
            measured_f0_hz: observation.f0_hz,
            target_midi: self.target_midi,
            target_hz: self.target_midi.map(midi_to_hz),
            cents_error: None,
            desired_correction_cents: 0.0,
            applied_correction_cents: self.applied_cents,
            correction_percent: (self.applied_cents.abs() / self.config.maximum_correction_cents
                * 100.0)
                .clamp(0.0, 100.0),
            confidence: observation.confidence,
            target_source: TargetSource::None,
        }
    }
}

pub fn midi_to_hz(note: u8) -> f32 {
    440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
}

fn pitch_class_allowed(note: u8, mask: u16) -> bool {
    mask & (1 << (note % 12)) != 0
}

fn nearest_allowed_midi(measured_midi: f32, mask: u16) -> u8 {
    (0_u8..=127)
        .filter(|note| pitch_class_allowed(*note, mask))
        .min_by(|left, right| {
            (measured_midi - *left as f32)
                .abs()
                .total_cmp(&(measured_midi - *right as f32).abs())
        })
        .unwrap_or_else(|| measured_midi.round().clamp(0.0, 127.0) as u8)
}

fn smooth(current: f32, target: f32, hop_frames: usize, time_ms: f32) -> f32 {
    if time_ms <= 0.0 {
        return target;
    }
    let hop_ms = hop_frames as f32 / SAMPLE_RATE as f32 * 1_000.0;
    let alpha = 1.0 - (-hop_ms / time_ms).exp();
    current + alpha * (target - current)
}

fn validate(config: &CorrectionPlannerConfig) -> Result<(), EngineError> {
    if config.hop_frames == 0
        || !(0.0..=1.0).contains(&config.minimum_confidence)
        || !(0.0..=1.0).contains(&config.strength)
        || !(0.0..=50.0).contains(&config.deadband_cents)
        || !(1.0..=200.0).contains(&config.maximum_correction_cents)
        || !(0.0..=49.0).contains(&config.target_hysteresis_cents)
        || config.attack_ms < 0.0
        || config.release_ms < 0.0
        || config.reset_target_after_ms <= 0.0
        || config.allowed_pitch_classes == 0
        || config.allowed_pitch_classes & !CHROMATIC_MASK != 0
    {
        return Err(EngineError("Pitch correction planner 配置无效".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(f0_hz: Option<f32>, confidence: f32) -> PitchObservation {
        PitchObservation {
            sample_position: 2048,
            time_seconds: 2048.0 / SAMPLE_RATE as f64,
            voiced: f0_hz.is_some(),
            f0_hz,
            confidence,
            rms_dbfs: -18.0,
        }
    }

    fn immediate_planner() -> CorrectionPlanner {
        CorrectionPlanner::new(CorrectionPlannerConfig {
            strength: 1.0,
            deadband_cents: 0.0,
            attack_ms: 0.0,
            release_ms: 0.0,
            ..CorrectionPlannerConfig::default()
        })
        .unwrap()
    }

    fn shifted(base: f32, cents: f32) -> f32 {
        base * 2.0_f32.powf(cents / 1_200.0)
    }

    #[test]
    fn creates_signed_correction_for_25_and_50_cent_errors() {
        let mut planner = immediate_planner();
        let sharp = planner.process(observation(Some(shifted(440.0, 25.0)), 0.99));
        assert_eq!(sharp.target_midi, Some(69));
        assert!((sharp.desired_correction_cents + 25.0).abs() < 0.01);
        let flat = planner.process(observation(Some(shifted(440.0, -50.0)), 0.99));
        assert!((flat.cents_error.unwrap() + 50.0).abs() < 0.01);
        assert_eq!(flat.desired_correction_cents, 45.0);
    }

    #[test]
    fn hysteresis_prevents_target_chatter_at_semitone_boundary() {
        let mut planner = immediate_planner();
        let initial = planner.process(observation(Some(shifted(440.0, 49.0)), 0.99));
        let retained = planner.process(observation(Some(shifted(440.0, 56.0)), 0.99));
        let switched = planner.process(observation(Some(shifted(440.0, 70.0)), 0.99));
        assert_eq!(initial.target_midi, Some(69));
        assert_eq!(retained.target_midi, Some(69));
        assert_eq!(switched.target_midi, Some(70));
    }

    #[test]
    fn exact_semitone_error_needs_reference_awareness() {
        let mut planner = immediate_planner();
        let decision = planner.process(observation(Some(shifted(440.0, 100.0)), 0.99));
        assert_eq!(decision.target_midi, Some(70));
        assert!(decision.cents_error.unwrap().abs() < 0.01);
        assert_eq!(decision.state, CorrectionState::Deadband);
    }

    #[test]
    fn silence_and_low_confidence_are_bypassed() {
        let mut planner = immediate_planner();
        let silence = planner.process(observation(None, 0.0));
        let uncertain = planner.process(observation(Some(440.0), 0.2));
        assert_eq!(silence.state, CorrectionState::Unvoiced);
        assert_eq!(uncertain.state, CorrectionState::LowConfidence);
        assert_eq!(uncertain.desired_correction_cents, 0.0);
    }

    #[test]
    fn correction_is_limited_before_audio_processing() {
        let mut planner = CorrectionPlanner::new(CorrectionPlannerConfig {
            strength: 1.0,
            deadband_cents: 0.0,
            maximum_correction_cents: 20.0,
            attack_ms: 0.0,
            ..CorrectionPlannerConfig::default()
        })
        .unwrap();
        let decision = planner.process(observation(Some(shifted(440.0, 40.0)), 0.99));
        assert_eq!(decision.desired_correction_cents, -20.0);
        assert_eq!(decision.correction_percent, 100.0);
    }

    #[test]
    fn c_major_rejects_a_c_sharp_target() {
        let mut planner = CorrectionPlanner::new(CorrectionPlannerConfig {
            strength: 1.0,
            deadband_cents: 0.0,
            attack_ms: 0.0,
            allowed_pitch_classes: scale_mask(parse_tonic("C").unwrap(), ScaleMode::Major),
            ..CorrectionPlannerConfig::default()
        })
        .unwrap();
        let c_sharp = midi_to_hz(61);
        let decision = planner.process(observation(Some(c_sharp), 0.99));
        assert_eq!(decision.target_midi, Some(60));
        assert_eq!(decision.target_source, TargetSource::Scale);
    }

    #[test]
    fn reference_target_overrides_a_valid_wrong_semitone() {
        let mut planner = immediate_planner();
        let sung_c_sharp = midi_to_hz(61);
        let decision = planner.process_with_reference(
            observation(Some(sung_c_sharp), 0.99),
            Some(ReferenceTarget {
                midi_note: 60,
                target_hz: midi_to_hz(60),
            }),
        );
        assert_eq!(decision.target_midi, Some(60));
        assert_eq!(decision.target_source, TargetSource::Reference);
        assert!((decision.cents_error.unwrap() - 100.0).abs() < 0.01);
        assert_eq!(decision.desired_correction_cents, -45.0);
    }
}
