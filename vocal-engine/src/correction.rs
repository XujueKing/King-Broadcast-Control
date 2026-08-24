use crate::{pitch::PitchObservation, EngineError, SAMPLE_RATE};
use serde::Serialize;

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

    pub fn process(&mut self, observation: PitchObservation) -> CorrectionDecision {
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
        let nearest = measured_midi.round().clamp(0.0, 127.0) as u8;
        let target_midi = match self.target_midi {
            Some(current)
                if (measured_midi - current as f32).abs()
                    <= 0.5 + self.config.target_hysteresis_cents / 100.0 =>
            {
                current
            }
            _ => nearest,
        };
        self.target_midi = Some(target_midi);
        let target_hz = midi_to_hz(target_midi);
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
        }
    }
}

pub fn midi_to_hz(note: u8) -> f32 {
    440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
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
}
