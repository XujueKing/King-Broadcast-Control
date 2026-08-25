use crate::{
    correction::{midi_to_hz, ReferenceTarget},
    pitch::PitchObservation,
    EngineError, SAMPLE_RATE,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceVocalMap {
    pub schema_version: u32,
    pub sample_rate: u32,
    pub hop_frames: usize,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_duration_samples: Option<u64>,
    #[serde(default)]
    pub timeline_offset_samples: i64,
    pub segments: Vec<ReferenceSegment>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSegment {
    pub start_sample: u64,
    pub end_sample: u64,
    pub midi_note: u8,
    pub target_hz: f32,
    pub confidence: f32,
}

#[derive(Clone, Debug)]
pub struct ReferenceBuildConfig {
    pub minimum_confidence: f32,
    pub hysteresis_cents: f32,
    pub maximum_gap_hops: usize,
}

impl Default for ReferenceBuildConfig {
    fn default() -> Self {
        Self {
            minimum_confidence: 0.72,
            hysteresis_cents: 12.0,
            maximum_gap_hops: 1,
        }
    }
}

impl ReferenceVocalMap {
    pub fn build(
        source: impl Into<String>,
        hop_frames: usize,
        observations: &[PitchObservation],
        config: &ReferenceBuildConfig,
    ) -> Result<Self, EngineError> {
        validate_build(hop_frames, config)?;
        let mut segments = Vec::<ReferenceSegment>::new();
        let mut current_note = None::<u8>;
        let maximum_gap = hop_frames as u64 * (config.maximum_gap_hops as u64 + 1);

        for observation in observations {
            let Some(f0) = observation.f0_hz.filter(|value| {
                observation.voiced
                    && observation.confidence >= config.minimum_confidence
                    && value.is_finite()
                    && *value > 0.0
            }) else {
                current_note = None;
                continue;
            };
            let measured_midi = 69.0 + 12.0 * (f0 / 440.0).log2();
            let nearest = measured_midi.round().clamp(0.0, 127.0) as u8;
            let selected = match current_note {
                Some(note)
                    if (measured_midi - note as f32).abs()
                        <= 0.5 + config.hysteresis_cents / 100.0 =>
                {
                    note
                }
                _ => nearest,
            };
            let end_sample = observation.sample_position + hop_frames as u64;
            if let Some(last) = segments.last_mut() {
                if last.midi_note == selected
                    && observation.sample_position <= last.end_sample + maximum_gap
                {
                    last.end_sample = end_sample;
                    last.confidence = (last.confidence + observation.confidence) * 0.5;
                    current_note = Some(selected);
                    continue;
                }
            }
            segments.push(ReferenceSegment {
                start_sample: observation.sample_position,
                end_sample,
                midi_note: selected,
                target_hz: midi_to_hz(selected),
                confidence: observation.confidence,
            });
            current_note = Some(selected);
        }
        Ok(Self {
            schema_version: 1,
            sample_rate: SAMPLE_RATE,
            hop_frames,
            source: source.into(),
            source_fingerprint: None,
            source_duration_samples: None,
            timeline_offset_samples: 0,
            segments,
        })
    }

    pub fn target_at(&self, sample_position: u64) -> Option<ReferenceTarget> {
        let index = self
            .segments
            .partition_point(|segment| segment.end_sample <= sample_position);
        let segment = self.segments.get(index)?;
        (segment.start_sample <= sample_position && sample_position < segment.end_sample).then_some(
            ReferenceTarget {
                midi_note: segment.midi_note,
                target_hz: segment.target_hz,
            },
        )
    }

    pub fn save(&self, path: &Path) -> Result<(), EngineError> {
        let encoded = serde_json::to_vec_pretty(self)
            .map_err(|error| EngineError(format!("无法编码 Reference Vocal Map：{error}")))?;
        fs::write(path, encoded)
            .map_err(|error| EngineError(format!("无法写入 {}：{error}", path.display())))
    }

    pub fn load(path: &Path) -> Result<Self, EngineError> {
        let encoded = fs::read(path)
            .map_err(|error| EngineError(format!("无法读取 {}：{error}", path.display())))?;
        let map: Self = serde_json::from_slice(&encoded)
            .map_err(|error| EngineError(format!("Reference Vocal Map 格式错误：{error}")))?;
        if map.schema_version != 1 || map.sample_rate != SAMPLE_RATE || map.hop_frames == 0 {
            return Err(EngineError("Reference Vocal Map 版本或采样率不兼容".into()));
        }
        if map
            .segments
            .iter()
            .any(|segment| segment.start_sample >= segment.end_sample)
            || map
                .segments
                .windows(2)
                .any(|pair| pair[0].start_sample > pair[1].start_sample)
        {
            return Err(EngineError("Reference Vocal Map 时间轴无效".into()));
        }
        if let Some(duration) = map.source_duration_samples {
            if map
                .segments
                .iter()
                .any(|segment| segment.end_sample > duration)
            {
                return Err(EngineError("Reference Vocal Map 超出歌曲时间轴".into()));
            }
        }
        Ok(map)
    }
}

fn validate_build(hop_frames: usize, config: &ReferenceBuildConfig) -> Result<(), EngineError> {
    if hop_frames == 0
        || !(0.0..=1.0).contains(&config.minimum_confidence)
        || !(0.0..=49.0).contains(&config.hysteresis_cents)
    {
        return Err(EngineError("Reference Vocal Map 构建参数无效".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(sample: u64, midi: f32) -> PitchObservation {
        PitchObservation {
            sample_position: sample,
            time_seconds: sample as f64 / SAMPLE_RATE as f64,
            voiced: true,
            f0_hz: Some(440.0 * 2.0_f32.powf((midi - 69.0) / 12.0)),
            confidence: 0.98,
            rms_dbfs: -18.0,
        }
    }

    #[test]
    fn compresses_contiguous_pitch_frames_into_segments() {
        let observations = [
            observation(0, 69.1),
            observation(128, 69.2),
            observation(256, 69.1),
            observation(384, 70.0),
        ];
        let map =
            ReferenceVocalMap::build("test", 128, &observations, &ReferenceBuildConfig::default())
                .unwrap();
        assert_eq!(map.segments.len(), 2);
        assert_eq!(map.segments[0].midi_note, 69);
        assert_eq!(map.segments[0].end_sample, 384);
        assert_eq!(map.target_at(200).unwrap().midi_note, 69);
        assert_eq!(map.target_at(400).unwrap().midi_note, 70);
    }

    #[test]
    fn gaps_and_unvoiced_regions_have_no_reference_target() {
        let observations = [observation(0, 69.0), observation(1024, 71.0)];
        let map =
            ReferenceVocalMap::build("test", 128, &observations, &ReferenceBuildConfig::default())
                .unwrap();
        assert!(map.target_at(64).is_some());
        assert!(map.target_at(512).is_none());
        assert_eq!(map.target_at(1024).unwrap().midi_note, 71);
    }
}
