use crate::{EngineError, SAMPLE_RATE};
use serde::Serialize;
use std::{
    array,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

const PRESET_BITS: u64 = 0xff;
const DEFAULT_MORPH_MS: f32 = 120.0;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[repr(u8)]
#[serde(rename_all = "snake_case")]
pub enum VocalPreset {
    Natural = 0,
    #[default]
    Professional = 1,
    Strong = 2,
    Auto = 3,
}

impl VocalPreset {
    fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Natural,
            2 => Self::Strong,
            3 => Self::Auto,
            _ => Self::Professional,
        }
    }

    fn resolve(self, quality_score: f32) -> Self {
        if self != Self::Auto {
            return self;
        }
        let score = if quality_score.is_finite() {
            quality_score.clamp(0.0, 100.0)
        } else {
            100.0
        };
        if score >= 82.0 {
            Self::Natural
        } else if score >= 52.0 {
            Self::Professional
        } else {
            Self::Strong
        }
    }
}

impl FromStr for VocalPreset {
    type Err = EngineError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "natural" | "自然" | "自然修音" => Ok(Self::Natural),
            "professional" | "pro" | "专业" | "专业增强" => Ok(Self::Professional),
            "strong" | "rescue" | "强力" | "强力修音" => Ok(Self::Strong),
            "auto" | "自动" => Ok(Self::Auto),
            _ => Err(EngineError(format!(
                "未知人声预设 {value}；可选 natural/professional/strong/auto"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalPresetFrame {
    pub requested: VocalPreset,
    pub resolved: VocalPreset,
    pub revision: u64,
    pub correction_strength: f32,
    pub deadband_cents: f32,
    pub maximum_correction_scale: f32,
    pub corrected_mix_scale: f32,
    pub dynamics_scale: f32,
}

impl VocalPresetFrame {
    fn targets(requested: VocalPreset, quality_score: f32, revision: u64) -> Self {
        let resolved = requested.resolve(quality_score);
        let (
            correction_strength,
            deadband_cents,
            maximum_correction_scale,
            corrected_mix_scale,
            dynamics_scale,
        ) = match resolved {
            VocalPreset::Natural => (0.42, 14.0, 0.55, 0.55, 0.55),
            VocalPreset::Professional => (0.75, 8.0, 0.80, 1.0, 0.80),
            VocalPreset::Strong => (1.0, 4.0, 1.0, 1.0, 1.0),
            VocalPreset::Auto => unreachable!("Auto must resolve to a concrete preset"),
        };
        Self {
            requested,
            resolved,
            revision,
            correction_strength,
            deadband_cents,
            maximum_correction_scale,
            corrected_mix_scale,
            dynamics_scale,
        }
    }
}

#[derive(Clone)]
pub struct VocalPresetControl {
    packed: Arc<AtomicU64>,
}

impl VocalPresetControl {
    pub fn new(initial: VocalPreset) -> Self {
        Self {
            packed: Arc::new(AtomicU64::new(initial as u64)),
        }
    }

    pub fn request(&self, preset: VocalPreset) -> u64 {
        let updated = self
            .packed
            .fetch_update(Ordering::Release, Ordering::Relaxed, |packed| {
                let revision = (packed >> 8).wrapping_add(1);
                Some((revision << 8) | preset as u64)
            })
            .unwrap_or_else(|packed| packed);
        (updated >> 8).wrapping_add(1)
    }

    pub fn receiver(&self) -> VocalPresetReceiver {
        VocalPresetReceiver {
            packed: Arc::clone(&self.packed),
        }
    }

    pub fn snapshot(&self) -> (VocalPreset, u64) {
        unpack(self.packed.load(Ordering::Acquire))
    }
}

#[derive(Clone)]
pub struct VocalPresetReceiver {
    packed: Arc<AtomicU64>,
}

impl VocalPresetReceiver {
    fn snapshot(&self) -> (VocalPreset, u64) {
        unpack(self.packed.load(Ordering::Acquire))
    }
}

fn unpack(packed: u64) -> (VocalPreset, u64) {
    (
        VocalPreset::from_code((packed & PRESET_BITS) as u8),
        packed >> 8,
    )
}

pub struct VocalPresetSmoother {
    receiver: VocalPresetReceiver,
    current: VocalPresetFrame,
    alpha: f32,
}

impl VocalPresetSmoother {
    pub fn new(receiver: VocalPresetReceiver, morph_ms: f32) -> Result<Self, EngineError> {
        if !morph_ms.is_finite() || !(10.0..=2_000.0).contains(&morph_ms) {
            return Err(EngineError("预设切换时间必须在 10..=2000 ms".into()));
        }
        let (requested, revision) = receiver.snapshot();
        Ok(Self {
            receiver,
            current: VocalPresetFrame::targets(requested, 100.0, revision),
            alpha: 1.0 - (-1.0 / (morph_ms * 0.001 * SAMPLE_RATE as f32)).exp(),
        })
    }

    pub fn with_default_morph(receiver: VocalPresetReceiver) -> Result<Self, EngineError> {
        Self::new(receiver, DEFAULT_MORPH_MS)
    }

    pub fn process_sample(&mut self, quality_score: f32) -> VocalPresetFrame {
        let (requested, revision) = self.receiver.snapshot();
        let target = VocalPresetFrame::targets(requested, quality_score, revision);
        self.current.requested = requested;
        self.current.resolved = target.resolved;
        self.current.revision = revision;
        self.current.correction_strength = smooth(
            self.current.correction_strength,
            target.correction_strength,
            self.alpha,
        );
        self.current.deadband_cents = smooth(
            self.current.deadband_cents,
            target.deadband_cents,
            self.alpha,
        );
        self.current.maximum_correction_scale = smooth(
            self.current.maximum_correction_scale,
            target.maximum_correction_scale,
            self.alpha,
        );
        self.current.corrected_mix_scale = smooth(
            self.current.corrected_mix_scale,
            target.corrected_mix_scale,
            self.alpha,
        );
        self.current.dynamics_scale = smooth(
            self.current.dynamics_scale,
            target.dynamics_scale,
            self.alpha,
        );
        self.current
    }
}

fn smooth(current: f32, target: f32, alpha: f32) -> f32 {
    current + alpha * (target - current)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VocalLaneId {
    Mic1,
    Mic2,
    Mic3,
}

impl VocalLaneId {
    fn index(self) -> usize {
        match self {
            Self::Mic1 => 0,
            Self::Mic2 => 1,
            Self::Mic3 => 2,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalLaneDefinition {
    pub id: VocalLaneId,
    pub qu_input_channel: u8,
    pub source_label: &'static str,
    pub hardware_status: &'static str,
    pub phantom_power: bool,
}

pub fn three_microphone_plan() -> [VocalLaneDefinition; 3] {
    [
        VocalLaneDefinition {
            id: VocalLaneId::Mic1,
            qu_input_channel: 1,
            source_label: "Shure SLX4",
            hardware_status: "confirmed_receiver_route_pending",
            phantom_power: false,
        },
        VocalLaneDefinition {
            id: VocalLaneId::Mic2,
            qu_input_channel: 2,
            source_label: "UHF Receiver A",
            hardware_status: "provisional_requires_rear_panel_and_route_check",
            phantom_power: false,
        },
        VocalLaneDefinition {
            id: VocalLaneId::Mic3,
            qu_input_channel: 3,
            source_label: "UHF Receiver B",
            hardware_status: "provisional_requires_rear_panel_and_route_check",
            phantom_power: false,
        },
    ]
}

pub struct ThreeLanePresetBank {
    controls: [VocalPresetControl; 3],
}

impl ThreeLanePresetBank {
    pub fn new(initial: VocalPreset) -> Self {
        Self {
            controls: array::from_fn(|_| VocalPresetControl::new(initial)),
        }
    }

    pub fn control(&self, lane: VocalLaneId) -> VocalPresetControl {
        self.controls[lane.index()].clone()
    }

    pub fn request(&self, lane: VocalLaneId, preset: VocalPreset) -> u64 {
        self.controls[lane.index()].request(preset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_request_is_observed_as_one_snapshot() {
        let control = VocalPresetControl::new(VocalPreset::Natural);
        let mut smoother = VocalPresetSmoother::new(control.receiver(), 10.0).unwrap();
        let revision = control.request(VocalPreset::Strong);
        let frame = smoother.process_sample(20.0);
        assert_eq!(frame.requested, VocalPreset::Strong);
        assert_eq!(frame.revision, revision);
        assert!(frame.correction_strength > 0.42);
        assert!(frame.correction_strength < 1.0);
    }

    #[test]
    fn three_lane_controls_do_not_leak_state() {
        let bank = ThreeLanePresetBank::new(VocalPreset::Professional);
        bank.request(VocalLaneId::Mic2, VocalPreset::Strong);
        assert_eq!(
            bank.control(VocalLaneId::Mic1).snapshot().0,
            VocalPreset::Professional
        );
        assert_eq!(
            bank.control(VocalLaneId::Mic2).snapshot().0,
            VocalPreset::Strong
        );
        assert_eq!(
            bank.control(VocalLaneId::Mic3).snapshot().0,
            VocalPreset::Professional
        );
    }

    #[test]
    fn auto_resolves_from_quality_without_parameter_jump() {
        let control = VocalPresetControl::new(VocalPreset::Auto);
        let mut smoother = VocalPresetSmoother::new(control.receiver(), 120.0).unwrap();
        let good = smoother.process_sample(95.0);
        let bad = smoother.process_sample(20.0);
        assert_eq!(good.resolved, VocalPreset::Natural);
        assert_eq!(bad.resolved, VocalPreset::Strong);
        assert!((bad.correction_strength - good.correction_strength).abs() < 0.01);
    }

    #[test]
    fn strong_switch_is_continuous_over_the_full_morph() {
        let control = VocalPresetControl::new(VocalPreset::Natural);
        let mut smoother = VocalPresetSmoother::new(control.receiver(), 120.0).unwrap();
        control.request(VocalPreset::Strong);
        let mut previous = smoother.process_sample(20.0);
        let mut maximum_step = 0.0_f32;
        for _ in 0..SAMPLE_RATE {
            let frame = smoother.process_sample(20.0);
            maximum_step = maximum_step.max(
                (frame.correction_strength - previous.correction_strength)
                    .abs()
                    .max((frame.corrected_mix_scale - previous.corrected_mix_scale).abs())
                    .max((frame.dynamics_scale - previous.dynamics_scale).abs()),
            );
            previous = frame;
        }
        assert!(
            maximum_step < 0.0002,
            "maximum parameter step {maximum_step}"
        );
        assert!((previous.correction_strength - 1.0).abs() < 0.001);
        assert!((previous.dynamics_scale - 1.0).abs() < 0.001);
    }

    #[test]
    fn wireless_receiver_plan_never_enables_phantom_power() {
        assert!(three_microphone_plan()
            .iter()
            .all(|lane| !lane.phantom_power));
    }
}
