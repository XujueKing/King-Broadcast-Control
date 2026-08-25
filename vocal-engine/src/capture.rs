use crate::{
    calibration::{CalibrationState, CalibrationWizard, CalibrationWizardReport},
    preset::VocalLaneId,
    routing::{AsioChannelDescriptor, AsioChannelInventory, AsioDirection},
    EngineError, SAMPLE_RATE,
};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    BufferSize, SampleFormat, Stream, StreamConfig,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc,
    },
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPeak {
    pub driver_index: usize,
    pub peak_dbfs: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterFrame {
    pub sequence: u64,
    pub frame_position: u64,
    pub direction: AsioDirection,
    pub peaks: Vec<ChannelPeak>,
}

impl MeterFrame {
    pub(crate) fn peak_pairs(&self) -> Vec<(usize, f32)> {
        self.peaks
            .iter()
            .map(|peak| (peak.driver_index, peak.peak_dbfs))
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterReplayFixture {
    pub schema_version: u32,
    pub name: String,
    pub inventory: AsioChannelInventory,
    pub frames: Vec<MeterFrame>,
    pub physical_capture: bool,
}

pub trait ReadOnlyMeterSource {
    fn inventory(&self) -> &AsioChannelInventory;
    fn next_frame(&mut self, timeout: Duration) -> Result<Option<MeterFrame>, EngineError>;
    fn physical_capture(&self) -> bool;
    fn output_stream_started(&self) -> bool {
        false
    }
    fn stop(&mut self);
}

pub struct ReplayMeterSource {
    fixture: MeterReplayFixture,
    frames: VecDeque<MeterFrame>,
}

impl ReplayMeterSource {
    pub fn new(fixture: MeterReplayFixture) -> Result<Self, EngineError> {
        validate_fixture(&fixture)?;
        Ok(Self {
            frames: fixture.frames.clone().into(),
            fixture,
        })
    }
}

impl ReadOnlyMeterSource for ReplayMeterSource {
    fn inventory(&self) -> &AsioChannelInventory {
        &self.fixture.inventory
    }

    fn next_frame(&mut self, _timeout: Duration) -> Result<Option<MeterFrame>, EngineError> {
        Ok(self.frames.pop_front())
    }

    fn physical_capture(&self) -> bool {
        false
    }

    fn stop(&mut self) {
        self.frames.clear();
    }
}

pub struct CpalInputMeterSource {
    inventory: AsioChannelInventory,
    receiver: Receiver<MeterFrame>,
    stream: Option<Stream>,
}

impl CpalInputMeterSource {
    pub fn open_read_only(device_name: &str, queue_capacity: usize) -> Result<Self, EngineError> {
        if device_name.trim().is_empty() || queue_capacity == 0 {
            return Err(EngineError(
                "read-only capture requires a device name and bounded queue".into(),
            ));
        }
        let host = cpal::default_host();
        let device = host
            .input_devices()
            .map_err(|error| EngineError(format!("input device enumeration failed: {error}")))?
            .find(|device| device.to_string() == device_name)
            .ok_or_else(|| EngineError(format!("input device not found: {device_name}")))?;
        let supported = device
            .supported_input_configs()
            .map_err(|error| EngineError(format!("input capability query failed: {error}")))?
            .find(|range| {
                range.sample_format() == SampleFormat::F32
                    && range.min_sample_rate() <= SAMPLE_RATE
                    && range.max_sample_rate() >= SAMPLE_RATE
            })
            .ok_or_else(|| EngineError("device has no 48 kHz float32 input mode".into()))?;
        let channels = supported.channels();
        let config = StreamConfig {
            channels,
            sample_rate: SAMPLE_RATE,
            buffer_size: BufferSize::Default,
        };
        let descriptors = (0..channels as usize)
            .map(|driver_index| AsioChannelDescriptor {
                driver_index,
                name: format!("{device_name} Input {}", driver_index + 1),
                direction: AsioDirection::Input,
            })
            .collect::<Vec<_>>();
        let inventory = AsioChannelInventory {
            driver_name: device_name.into(),
            sample_rate: SAMPLE_RATE,
            physical_hardware: true,
            input_channels: descriptors,
            output_channels: Vec::new(),
        };
        let (sender, receiver) = mpsc::sync_channel(queue_capacity);
        let sequence = Arc::new(AtomicU64::new(0));
        let frame_position = Arc::new(AtomicU64::new(0));
        let clock_anchor = crate::live_joint::Usb48kClockAnchor::from_unix_ms(unix_time_ms(), 0);
        let stream = build_read_only_input_stream(
            &device,
            &config,
            sender,
            sequence,
            frame_position,
            clock_anchor,
        )?;
        stream
            .play()
            .map_err(|error| EngineError(format!("input-only stream start failed: {error}")))?;
        Ok(Self {
            inventory,
            receiver,
            stream: Some(stream),
        })
    }
}

impl ReadOnlyMeterSource for CpalInputMeterSource {
    fn inventory(&self) -> &AsioChannelInventory {
        &self.inventory
    }

    fn next_frame(&mut self, timeout: Duration) -> Result<Option<MeterFrame>, EngineError> {
        if self.stream.is_none() {
            return Err(EngineError("input-only meter source is stopped".into()));
        }
        match self.receiver.recv_timeout(timeout) {
            Ok(frame) => Ok(Some(frame)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(EngineError("input-only meter stream disconnected".into()))
            }
        }
    }

    fn physical_capture(&self) -> bool {
        true
    }

    fn stop(&mut self) {
        self.stream.take();
    }
}

fn build_read_only_input_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sender: SyncSender<MeterFrame>,
    sequence: Arc<AtomicU64>,
    frame_position: Arc<AtomicU64>,
    clock_anchor: crate::live_joint::Usb48kClockAnchor,
) -> Result<Stream, EngineError> {
    let channels = config.channels as usize;
    device
        .build_input_stream(
            *config,
            move |data: &[f32], _| {
                let frame_count = data.len() / channels;
                let mut peaks = vec![0.0_f32; channels];
                for frame in data.chunks_exact(channels) {
                    for (channel, sample) in frame.iter().enumerate() {
                        peaks[channel] = peaks[channel].max(sample.abs());
                    }
                }
                let local_frame_position =
                    frame_position.fetch_add(frame_count as u64, Ordering::Relaxed);
                let message = MeterFrame {
                    sequence: sequence.fetch_add(1, Ordering::Relaxed) + 1,
                    frame_position: clock_anchor.map(local_frame_position),
                    direction: AsioDirection::Input,
                    peaks: peaks
                        .into_iter()
                        .enumerate()
                        .map(|(driver_index, peak)| ChannelPeak {
                            driver_index,
                            peak_dbfs: amplitude_to_dbfs(peak),
                        })
                        .collect(),
                };
                match sender.try_send(message) {
                    Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
                }
            },
            move |error| eprintln!("read-only input meter error: {error}"),
            None,
        )
        .map_err(|error| EngineError(format!("input-only stream build failed: {error}")))
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn amplitude_to_dbfs(amplitude: f32) -> f32 {
    if !amplitude.is_finite() || amplitude <= 0.000_001 {
        -120.0
    } else {
        (20.0 * amplitude.log10()).clamp(-120.0, 0.0)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterReplayReport {
    pub schema_version: u32,
    pub source_mode: &'static str,
    pub fixture_name: String,
    pub consumed_frames: usize,
    pub source_exhausted: bool,
    pub output_stream_started: bool,
    pub calibration: CalibrationWizardReport,
}

pub fn run_default_meter_replay() -> Result<MeterReplayReport, EngineError> {
    run_meter_replay(default_meter_fixture())
}

pub fn run_meter_replay(fixture: MeterReplayFixture) -> Result<MeterReplayReport, EngineError> {
    let fixture_name = fixture.name.clone();
    let mut source = ReplayMeterSource::new(fixture)?;
    let inventory = source.inventory().clone();
    let output_stream_started = source.output_stream_started();
    let mut wizard = CalibrationWizard::new_virtual(inventory)?;
    let mut consumed_frames = 0;
    for lane in [VocalLaneId::Mic1, VocalLaneId::Mic2, VocalLaneId::Mic3] {
        wizard.start_lane(lane)?;
        for _ in 0..3 {
            wizard.countdown_tick()?;
        }
        while matches!(
            wizard.state(),
            CalibrationState::TracingInput | CalibrationState::TracingReturn
        ) {
            let frame = source
                .next_frame(Duration::from_millis(100))?
                .ok_or_else(|| {
                    EngineError("meter replay exhausted before calibration completed".into())
                })?;
            consumed_frames += 1;
            let _ = wizard.observe(frame.direction, &frame.peak_pairs());
        }
    }
    let source_exhausted = source.next_frame(Duration::from_millis(0))?.is_none();
    source.stop();
    Ok(MeterReplayReport {
        schema_version: 1,
        source_mode: "recorded_meter_replay",
        fixture_name,
        consumed_frames,
        source_exhausted,
        output_stream_started,
        calibration: wizard.finish()?,
    })
}

pub fn default_meter_fixture() -> MeterReplayFixture {
    let inputs = [
        (2, "Recorded Mic A"),
        (5, "Recorded Mic B"),
        (9, "Recorded Mic C"),
    ];
    let outputs = [
        (1, "Recorded Return A"),
        (4, "Recorded Return B"),
        (8, "Recorded Return C"),
    ];
    let mut sequence = 0_u64;
    let mut frames = Vec::new();
    for (position, ((input, _), (output, _))) in inputs.iter().zip(outputs.iter()).enumerate() {
        if position == 1 {
            frames.push(frame(
                &mut sequence,
                AsioDirection::Input,
                &[(*input, -12.0), (9, -17.0)],
            ));
        }
        frames.push(frame(
            &mut sequence,
            AsioDirection::Input,
            &[(*input, -12.0), (99, -82.0)],
        ));
        frames.push(frame(
            &mut sequence,
            AsioDirection::Output,
            &[(*output, -11.0), (98, -81.0)],
        ));
    }
    MeterReplayFixture {
        schema_version: 1,
        name: "three_lane_with_one_crosstalk_retry".into(),
        inventory: AsioChannelInventory {
            driver_name: "KING Recorded Qu-16 Meter Fixture".into(),
            sample_rate: SAMPLE_RATE,
            physical_hardware: false,
            input_channels: inputs
                .into_iter()
                .map(|(driver_index, name)| descriptor(driver_index, name, AsioDirection::Input))
                .collect(),
            output_channels: outputs
                .into_iter()
                .map(|(driver_index, name)| descriptor(driver_index, name, AsioDirection::Output))
                .collect(),
        },
        frames,
        physical_capture: false,
    }
}

fn frame(sequence: &mut u64, direction: AsioDirection, peaks: &[(usize, f32)]) -> MeterFrame {
    *sequence += 1;
    MeterFrame {
        sequence: *sequence,
        frame_position: (*sequence - 1) * 480,
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

fn validate_fixture(fixture: &MeterReplayFixture) -> Result<(), EngineError> {
    if fixture.schema_version != 1
        || fixture.inventory.sample_rate != SAMPLE_RATE
        || fixture.physical_capture
        || fixture.inventory.physical_hardware
    {
        return Err(EngineError(
            "replay fixture must be schema 1, 48 kHz and explicitly non-physical".into(),
        ));
    }
    let mut previous_sequence = 0;
    let mut previous_position = 0;
    for frame in &fixture.frames {
        if frame.sequence <= previous_sequence
            || (previous_sequence > 0 && frame.frame_position < previous_position)
            || frame.peaks.iter().any(|peak| !peak.peak_dbfs.is_finite())
        {
            return Err(EngineError(
                "replay fixture sequence, timing or peaks are invalid".into(),
            ));
        }
        previous_sequence = frame.sequence;
        previous_position = frame.frame_position;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amplitude_conversion_is_finite_and_bounded() {
        assert_eq!(amplitude_to_dbfs(0.0), -120.0);
        assert_eq!(amplitude_to_dbfs(f32::NAN), -120.0);
        assert_eq!(amplitude_to_dbfs(1.0), 0.0);
        assert!((amplitude_to_dbfs(0.5) + 6.0206).abs() < 0.001);
    }

    #[test]
    fn replay_uses_the_same_wizard_and_never_starts_output() {
        let report = run_default_meter_replay().unwrap();
        assert_eq!(report.calibration.final_state, CalibrationState::Complete);
        assert_eq!(report.calibration.completed_lanes, 3);
        assert_eq!(report.calibration.rejected_observations, 1);
        assert!(!report.calibration.hardware_ready);
        assert!(!report.output_stream_started);
        assert!(report.source_exhausted);
    }

    #[test]
    fn truncated_replay_fails_closed() {
        let mut fixture = default_meter_fixture();
        fixture.frames.pop();
        assert!(run_meter_replay(fixture).is_err());
    }

    #[test]
    fn fixture_cannot_claim_physical_capture() {
        let mut fixture = default_meter_fixture();
        fixture.physical_capture = true;
        assert!(ReplayMeterSource::new(fixture).is_err());
    }

    #[test]
    fn bounded_replay_preserves_non_contiguous_driver_indices() {
        let report = run_default_meter_replay().unwrap();
        assert_eq!(
            report
                .calibration
                .routing_map
                .lanes
                .iter()
                .map(|route| route.input_driver_index)
                .collect::<Vec<_>>(),
            vec![2, 5, 9]
        );
    }
}
