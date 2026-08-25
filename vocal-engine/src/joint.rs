use crate::{
    calibration::{CalibrationState, CalibrationWizard, CalibrationWizardReport},
    capture::{
        ChannelPeak, MeterFrame, MeterReplayFixture, ReadOnlyMeterSource, ReplayMeterSource,
    },
    preset::VocalLaneId,
    routing::{AsioChannelDescriptor, AsioChannelInventory, AsioDirection},
    EngineError, SAMPLE_RATE,
};
use serde::Serialize;
use std::time::Duration;

const JOINT_SCHEMA_VERSION: u32 = 1;
const MAX_SKEW_FRAMES: u64 = 960;
const FRAME_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JointLaneEvidence {
    pub lane: VocalLaneId,
    pub input_sequence: u64,
    pub return_sequence: u64,
    pub input_frame_position: u64,
    pub return_frame_position: u64,
    pub skew_frames: u64,
    pub synchronized: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JointCalibrationReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub input_source: String,
    pub return_source: String,
    pub lane_evidence: Vec<JointLaneEvidence>,
    pub rejected_sync_frames: usize,
    pub maximum_observed_skew_frames: u64,
    pub maximum_allowed_skew_frames: u64,
    pub all_lanes_synchronized: bool,
    pub input_source_exhausted: bool,
    pub return_source_exhausted: bool,
    pub output_stream_started: bool,
    pub calibration: CalibrationWizardReport,
    pub hardware_ready: bool,
}

pub fn run_default_joint_replay() -> Result<JointCalibrationReport, EngineError> {
    let (input_fixture, return_fixture) = default_joint_fixtures(false);
    run_joint_replay(input_fixture, return_fixture)
}

pub fn run_joint_replay(
    input_fixture: MeterReplayFixture,
    return_fixture: MeterReplayFixture,
) -> Result<JointCalibrationReport, EngineError> {
    let input_name = input_fixture.name.clone();
    let return_name = return_fixture.name.clone();
    let mut input_source = ReplayMeterSource::new(input_fixture)?;
    let mut return_source = ReplayMeterSource::new(return_fixture)?;
    validate_source_roles(&input_source, &return_source)?;
    let inventory = combine_inventory(input_source.inventory(), return_source.inventory())?;
    let output_stream_started =
        input_source.output_stream_started() || return_source.output_stream_started();
    let mut wizard = CalibrationWizard::new_virtual(inventory)?;
    let mut lane_evidence = Vec::new();
    let mut rejected_sync_frames = 0;

    for lane in [VocalLaneId::Mic1, VocalLaneId::Mic2, VocalLaneId::Mic3] {
        wizard.start_lane(lane)?;
        for _ in 0..3 {
            wizard.countdown_tick()?;
        }
        let input = next_accepted_frame(&mut input_source, &mut wizard, AsioDirection::Input)?;
        let returned = loop {
            let candidate = return_source
                .next_frame(FRAME_TIMEOUT)?
                .ok_or_else(|| EngineError("Qu-16 return evidence timed out".into()))?;
            if candidate.direction != AsioDirection::Output {
                return Err(EngineError(
                    "return evidence source produced a non-output frame".into(),
                ));
            }
            let skew_frames = input.frame_position.abs_diff(candidate.frame_position);
            if skew_frames > MAX_SKEW_FRAMES {
                rejected_sync_frames += 1;
                continue;
            }
            match wizard.observe(candidate.direction, &candidate.peak_pairs()) {
                Ok(()) => break candidate,
                Err(_) if wizard.state() == CalibrationState::TracingReturn => continue,
                Err(error) => return Err(error),
            }
        };
        let skew_frames = input.frame_position.abs_diff(returned.frame_position);
        lane_evidence.push(JointLaneEvidence {
            lane,
            input_sequence: input.sequence,
            return_sequence: returned.sequence,
            input_frame_position: input.frame_position,
            return_frame_position: returned.frame_position,
            skew_frames,
            synchronized: skew_frames <= MAX_SKEW_FRAMES,
        });
    }

    let input_source_exhausted = input_source.next_frame(Duration::ZERO)?.is_none();
    let return_source_exhausted = return_source.next_frame(Duration::ZERO)?.is_none();
    input_source.stop();
    return_source.stop();
    let calibration = wizard.finish()?;
    let maximum_observed_skew_frames = lane_evidence
        .iter()
        .map(|evidence| evidence.skew_frames)
        .max()
        .unwrap_or(0);
    let all_lanes_synchronized =
        lane_evidence.len() == 3 && lane_evidence.iter().all(|evidence| evidence.synchronized);
    Ok(JointCalibrationReport {
        schema_version: JOINT_SCHEMA_VERSION,
        mode: "joint_recorded_evidence_replay",
        input_source: input_name,
        return_source: return_name,
        lane_evidence,
        rejected_sync_frames,
        maximum_observed_skew_frames,
        maximum_allowed_skew_frames: MAX_SKEW_FRAMES,
        all_lanes_synchronized,
        input_source_exhausted,
        return_source_exhausted,
        output_stream_started,
        hardware_ready: false,
        calibration,
    })
}

fn next_accepted_frame<S: ReadOnlyMeterSource>(
    source: &mut S,
    wizard: &mut CalibrationWizard,
    direction: AsioDirection,
) -> Result<MeterFrame, EngineError> {
    loop {
        let frame = source
            .next_frame(FRAME_TIMEOUT)?
            .ok_or_else(|| EngineError("USB input evidence timed out".into()))?;
        if frame.direction != direction {
            return Err(EngineError(
                "input evidence source direction mismatch".into(),
            ));
        }
        match wizard.observe(frame.direction, &frame.peak_pairs()) {
            Ok(()) => return Ok(frame),
            Err(_) if wizard.state() == CalibrationState::TracingInput => continue,
            Err(error) => return Err(error),
        }
    }
}

fn validate_source_roles<I: ReadOnlyMeterSource, R: ReadOnlyMeterSource>(
    input: &I,
    returned: &R,
) -> Result<(), EngineError> {
    if input.physical_capture()
        || returned.physical_capture()
        || input.output_stream_started()
        || returned.output_stream_started()
    {
        return Err(EngineError(
            "joint replay accepts only non-physical read-only fixtures".into(),
        ));
    }
    if input.inventory().input_channels.is_empty()
        || !input.inventory().output_channels.is_empty()
        || returned.inventory().output_channels.is_empty()
        || !returned.inventory().input_channels.is_empty()
    {
        return Err(EngineError(
            "joint evidence sources must have separate input and return roles".into(),
        ));
    }
    Ok(())
}

fn combine_inventory(
    input: &AsioChannelInventory,
    returned: &AsioChannelInventory,
) -> Result<AsioChannelInventory, EngineError> {
    if input.sample_rate != SAMPLE_RATE || returned.sample_rate != SAMPLE_RATE {
        return Err(EngineError(
            "joint evidence requires 48000 Hz sources".into(),
        ));
    }
    Ok(AsioChannelInventory {
        driver_name: "KING Joint USB + Qu-16 Meter Evidence".into(),
        sample_rate: SAMPLE_RATE,
        physical_hardware: false,
        input_channels: input.input_channels.clone(),
        output_channels: returned.output_channels.clone(),
    })
}

pub fn default_joint_fixtures(
    stale_first_return: bool,
) -> (MeterReplayFixture, MeterReplayFixture) {
    let input_channels = [(2, "USB Mic A"), (5, "USB Mic B"), (9, "USB Mic C")];
    let return_channels = [
        (1, "Qu-16 Return A"),
        (4, "Qu-16 Return B"),
        (8, "Qu-16 Return C"),
    ];
    let input_positions = [4_800_u64, 9_600, 14_400];
    let return_positions = [4_920_u64, 9_720, 14_520];
    let input_frames = input_channels
        .iter()
        .zip(input_positions)
        .enumerate()
        .map(|(index, ((driver_index, _), position))| {
            meter_frame(
                index as u64 + 1,
                position,
                AsioDirection::Input,
                &[(*driver_index, -12.0), (99, -82.0)],
            )
        })
        .collect::<Vec<_>>();
    let mut return_frames = Vec::new();
    if stale_first_return {
        return_frames.push(meter_frame(
            1,
            2_000,
            AsioDirection::Output,
            &[(1, -11.0), (98, -81.0)],
        ));
    }
    let offset = return_frames.len() as u64;
    return_frames.extend(
        return_channels
            .iter()
            .zip(return_positions)
            .enumerate()
            .map(|(index, ((driver_index, _), position))| {
                meter_frame(
                    offset + index as u64 + 1,
                    position,
                    AsioDirection::Output,
                    &[(*driver_index, -11.0), (98, -81.0)],
                )
            }),
    );
    (
        MeterReplayFixture {
            schema_version: 1,
            name: "recorded_usb_input_evidence".into(),
            inventory: AsioChannelInventory {
                driver_name: "Recorded USB Input".into(),
                sample_rate: SAMPLE_RATE,
                physical_hardware: false,
                input_channels: input_channels
                    .into_iter()
                    .map(|(index, name)| descriptor(index, name, AsioDirection::Input))
                    .collect(),
                output_channels: Vec::new(),
            },
            frames: input_frames,
            physical_capture: false,
        },
        MeterReplayFixture {
            schema_version: 1,
            name: "recorded_qu16_return_meter_evidence".into(),
            inventory: AsioChannelInventory {
                driver_name: "Recorded Qu-16 TCP Meter".into(),
                sample_rate: SAMPLE_RATE,
                physical_hardware: false,
                input_channels: Vec::new(),
                output_channels: return_channels
                    .into_iter()
                    .map(|(index, name)| descriptor(index, name, AsioDirection::Output))
                    .collect(),
            },
            frames: return_frames,
            physical_capture: false,
        },
    )
}

fn meter_frame(
    sequence: u64,
    frame_position: u64,
    direction: AsioDirection,
    peaks: &[(usize, f32)],
) -> MeterFrame {
    MeterFrame {
        sequence,
        frame_position,
        direction,
        peaks: peaks
            .iter()
            .map(|(driver_index, peak_dbfs)| ChannelPeak {
                driver_index: *driver_index,
                peak_dbfs: *peak_dbfs,
            })
            .collect(),
    }
}

fn descriptor(driver_index: usize, name: &str, direction: AsioDirection) -> AsioChannelDescriptor {
    AsioChannelDescriptor {
        driver_index,
        name: name.into(),
        direction,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synchronized_sources_complete_all_lanes_without_output() {
        let report = run_default_joint_replay().unwrap();
        assert!(report.all_lanes_synchronized);
        assert_eq!(report.maximum_observed_skew_frames, 120);
        assert_eq!(report.lane_evidence.len(), 3);
        assert!(!report.output_stream_started);
        assert!(!report.hardware_ready);
    }

    #[test]
    fn stale_return_frame_is_rejected_before_matching_frame() {
        let (input, returned) = default_joint_fixtures(true);
        let report = run_joint_replay(input, returned).unwrap();
        assert_eq!(report.rejected_sync_frames, 1);
        assert!(report.all_lanes_synchronized);
    }

    #[test]
    fn missing_return_evidence_fails_closed() {
        let (input, mut returned) = default_joint_fixtures(false);
        returned.frames.pop();
        assert!(run_joint_replay(input, returned).is_err());
    }

    #[test]
    fn mixed_source_roles_are_rejected() {
        let (mut input, returned) = default_joint_fixtures(false);
        input.inventory.output_channels = returned.inventory.output_channels.clone();
        assert!(run_joint_replay(input, returned).is_err());
    }
}
