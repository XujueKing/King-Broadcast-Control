use crate::{
    preset::VocalLaneId,
    routing::{
        AsioChannelDescriptor, AsioChannelInventory, AsioDirection, RouteEvidence, VocalLaneRoute,
        VocalRoutingMap,
    },
    EngineError, SAMPLE_RATE,
};
use serde::Serialize;

const CALIBRATION_SCHEMA_VERSION: u32 = 1;
const COUNTDOWN_TICKS: u8 = 3;
const MINIMUM_PEAK_DBFS: f32 = -36.0;
const MINIMUM_ISOLATION_DB: f32 = 18.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationState {
    Idle,
    Countdown,
    TracingInput,
    TracingReturn,
    LaneComplete,
    Complete,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationRejection {
    NoSignal,
    AmbiguousSignal,
    WrongDirection,
    WrongLaneOrder,
    NotReady,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationEvent {
    pub sequence: usize,
    pub state: CalibrationState,
    pub lane: Option<VocalLaneId>,
    pub accepted: bool,
    pub rejection: Option<CalibrationRejection>,
    pub selected_driver_index: Option<usize>,
    pub peak_dbfs: Option<f32>,
    pub isolation_db: Option<f32>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationWizardReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub final_state: CalibrationState,
    pub completed_lanes: usize,
    pub rejected_observations: usize,
    pub routing_map: VocalRoutingMap,
    pub events: Vec<CalibrationEvent>,
    pub physical_audio_started: bool,
    pub qu16_writes_performed: bool,
    pub hardware_ready: bool,
}

#[derive(Clone, Copy, Debug)]
struct Selection {
    driver_index: usize,
    peak_dbfs: f32,
    isolation_db: f32,
}

pub struct CalibrationWizard {
    inventory: AsioChannelInventory,
    state: CalibrationState,
    active_lane: Option<VocalLaneId>,
    countdown_remaining: u8,
    pending_input: Option<Selection>,
    routes: Vec<VocalLaneRoute>,
    events: Vec<CalibrationEvent>,
    rejected_observations: usize,
}

impl CalibrationWizard {
    pub fn new_virtual(inventory: AsioChannelInventory) -> Result<Self, EngineError> {
        if inventory.physical_hardware {
            return Err(EngineError(
                "virtual calibration refuses a physical-hardware inventory".into(),
            ));
        }
        if inventory.sample_rate != SAMPLE_RATE {
            return Err(EngineError("calibration requires 48000 Hz".into()));
        }
        Ok(Self {
            inventory,
            state: CalibrationState::Idle,
            active_lane: None,
            countdown_remaining: 0,
            pending_input: None,
            routes: Vec::new(),
            events: Vec::new(),
            rejected_observations: 0,
        })
    }

    pub fn state(&self) -> CalibrationState {
        self.state
    }

    pub fn start_lane(&mut self, lane: VocalLaneId) -> Result<(), EngineError> {
        if matches!(
            self.state,
            CalibrationState::Cancelled | CalibrationState::Complete
        ) {
            return Err(EngineError("calibration session is terminal".into()));
        }
        if self.active_lane.is_some() {
            return Err(EngineError("another vocal lane is already active".into()));
        }
        let expected = lane_at(self.routes.len())
            .ok_or_else(|| EngineError("all vocal lanes are already calibrated".into()))?;
        if lane != expected {
            self.reject(
                Some(lane),
                CalibrationRejection::WrongLaneOrder,
                "必须按 Mic1、Mic2、Mic3 顺序逐路确认",
            );
            return Err(EngineError(
                "vocal lanes must be calibrated in order".into(),
            ));
        }
        self.active_lane = Some(lane);
        self.pending_input = None;
        self.countdown_remaining = COUNTDOWN_TICKS;
        self.state = CalibrationState::Countdown;
        self.event(
            true,
            None,
            None,
            None,
            "请只打开当前麦克风，其他麦克风保持静音",
        );
        Ok(())
    }

    pub fn countdown_tick(&mut self) -> Result<u8, EngineError> {
        if self.state != CalibrationState::Countdown {
            return Err(EngineError("countdown is not active".into()));
        }
        self.countdown_remaining = self.countdown_remaining.saturating_sub(1);
        if self.countdown_remaining == 0 {
            self.state = CalibrationState::TracingInput;
            self.event(
                true,
                None,
                None,
                None,
                "请对当前麦克风持续说话，正在识别唯一 USB 输入",
            );
        } else {
            self.event(
                true,
                None,
                None,
                None,
                &format!("倒计时 {}", self.countdown_remaining),
            );
        }
        Ok(self.countdown_remaining)
    }

    pub fn observe(
        &mut self,
        direction: AsioDirection,
        peaks: &[(usize, f32)],
    ) -> Result<(), EngineError> {
        let expected_direction = match self.state {
            CalibrationState::TracingInput => AsioDirection::Input,
            CalibrationState::TracingReturn => AsioDirection::Output,
            _ => {
                self.reject(
                    self.active_lane,
                    CalibrationRejection::NotReady,
                    "当前阶段不接受信号观测",
                );
                return Err(EngineError(
                    "calibration is not ready for observation".into(),
                ));
            }
        };
        if direction != expected_direction {
            self.reject(
                self.active_lane,
                CalibrationRejection::WrongDirection,
                "信号方向与当前校准步骤不匹配",
            );
            return Err(EngineError("wrong calibration signal direction".into()));
        }
        let selection = match select_unique_peak(peaks) {
            Ok(selection) => selection,
            Err(rejection) => {
                let message = match rejection {
                    CalibrationRejection::NoSignal => "没有检测到足够清晰的信号，请继续说话",
                    CalibrationRejection::AmbiguousSignal => {
                        "检测到多路相近信号，请关闭其他麦克风后重试"
                    }
                    _ => "信号观测被拒绝",
                };
                self.reject(self.active_lane, rejection, message);
                return Err(EngineError(message.into()));
            }
        };
        self.ensure_channel_exists(direction, selection.driver_index)?;
        if direction == AsioDirection::Input {
            self.pending_input = Some(selection);
            self.state = CalibrationState::TracingReturn;
            self.event(
                true,
                Some(selection.driver_index),
                Some(selection.peak_dbfs),
                Some(selection.isolation_db),
                "输入通道已锁定，正在识别对应处理返回",
            );
            return Ok(());
        }

        let lane = self
            .active_lane
            .ok_or_else(|| EngineError("active vocal lane is missing".into()))?;
        let input = self
            .pending_input
            .take()
            .ok_or_else(|| EngineError("input route has not been selected".into()))?;
        let input_name = channel_name(
            &self.inventory.input_channels,
            AsioDirection::Input,
            input.driver_index,
        )?;
        let return_name = channel_name(
            &self.inventory.output_channels,
            AsioDirection::Output,
            selection.driver_index,
        )?;
        self.routes.push(VocalLaneRoute {
            lane,
            qu_input_channel: self.routes.len() as u8 + 1,
            input_driver_index: input.driver_index,
            input_channel_name: input_name,
            return_driver_index: selection.driver_index,
            return_channel_name: return_name,
            evidence: RouteEvidence::VirtualSignalTrace,
        });
        self.active_lane = None;
        self.state = if self.routes.len() == 3 {
            CalibrationState::Complete
        } else {
            CalibrationState::LaneComplete
        };
        self.event(
            true,
            Some(selection.driver_index),
            Some(selection.peak_dbfs),
            Some(selection.isolation_db),
            if self.state == CalibrationState::Complete {
                "三路离线校准完成；现场硬件仍保持阻断"
            } else {
                "当前麦克风输入与返回已绑定"
            },
        );
        Ok(())
    }

    pub fn cancel(&mut self) {
        if !matches!(
            self.state,
            CalibrationState::Complete | CalibrationState::Cancelled
        ) {
            self.state = CalibrationState::Cancelled;
            self.active_lane = None;
            self.pending_input = None;
            self.event(false, None, None, None, "校准已取消，未保存未完成的通道");
        }
    }

    pub fn finish(self) -> Result<CalibrationWizardReport, EngineError> {
        if self.state != CalibrationState::Complete || self.routes.len() != 3 {
            return Err(EngineError("calibration wizard is not complete".into()));
        }
        let routing_map = VocalRoutingMap {
            schema_version: 1,
            driver_name: self.inventory.driver_name.clone(),
            sample_rate: SAMPLE_RATE,
            physical_hardware: false,
            qu16_mapping_verified: false,
            lanes: self.routes,
            created_by: "virtual_calibration_wizard".into(),
            blockers: vec![
                "Virtual calibration cannot unlock physical routing".into(),
                "Qu-16 USB-B onsite trace is still required".into(),
            ],
        };
        routing_map.validate_against(&self.inventory)?;
        let hardware_ready = routing_map.hardware_ready(&self.inventory);
        Ok(CalibrationWizardReport {
            schema_version: CALIBRATION_SCHEMA_VERSION,
            mode: "virtual_calibration_wizard",
            final_state: CalibrationState::Complete,
            completed_lanes: 3,
            rejected_observations: self.rejected_observations,
            routing_map,
            events: self.events,
            physical_audio_started: false,
            qu16_writes_performed: false,
            hardware_ready,
        })
    }

    fn ensure_channel_exists(
        &mut self,
        direction: AsioDirection,
        driver_index: usize,
    ) -> Result<(), EngineError> {
        let channels = match direction {
            AsioDirection::Input => &self.inventory.input_channels,
            AsioDirection::Output => &self.inventory.output_channels,
        };
        if channels
            .iter()
            .any(|channel| channel.direction == direction && channel.driver_index == driver_index)
        {
            return Ok(());
        }
        self.reject(
            self.active_lane,
            CalibrationRejection::WrongDirection,
            "选中的驱动通道不在发现清单中",
        );
        Err(EngineError(
            "selected driver channel is not in inventory".into(),
        ))
    }

    fn reject(
        &mut self,
        lane: Option<VocalLaneId>,
        rejection: CalibrationRejection,
        message: &str,
    ) {
        self.rejected_observations += 1;
        self.events.push(CalibrationEvent {
            sequence: self.events.len() + 1,
            state: self.state,
            lane,
            accepted: false,
            rejection: Some(rejection),
            selected_driver_index: None,
            peak_dbfs: None,
            isolation_db: None,
            message: message.into(),
        });
    }

    fn event(
        &mut self,
        accepted: bool,
        selected_driver_index: Option<usize>,
        peak_dbfs: Option<f32>,
        isolation_db: Option<f32>,
        message: &str,
    ) {
        self.events.push(CalibrationEvent {
            sequence: self.events.len() + 1,
            state: self.state,
            lane: self
                .active_lane
                .or_else(|| self.routes.last().map(|route| route.lane)),
            accepted,
            rejection: None,
            selected_driver_index,
            peak_dbfs,
            isolation_db,
            message: message.into(),
        });
    }
}

fn select_unique_peak(peaks: &[(usize, f32)]) -> Result<Selection, CalibrationRejection> {
    let mut finite = peaks
        .iter()
        .copied()
        .filter(|(_, peak)| peak.is_finite())
        .collect::<Vec<_>>();
    finite.sort_by(|left, right| right.1.total_cmp(&left.1));
    let Some((driver_index, strongest)) = finite.first().copied() else {
        return Err(CalibrationRejection::NoSignal);
    };
    if strongest < MINIMUM_PEAK_DBFS {
        return Err(CalibrationRejection::NoSignal);
    }
    let second = finite.get(1).map(|(_, peak)| *peak).unwrap_or(-120.0);
    let isolation = strongest - second;
    if isolation < MINIMUM_ISOLATION_DB {
        return Err(CalibrationRejection::AmbiguousSignal);
    }
    Ok(Selection {
        driver_index,
        peak_dbfs: strongest,
        isolation_db: isolation,
    })
}

fn channel_name(
    channels: &[AsioChannelDescriptor],
    direction: AsioDirection,
    driver_index: usize,
) -> Result<String, EngineError> {
    channels
        .iter()
        .find(|channel| channel.direction == direction && channel.driver_index == driver_index)
        .map(|channel| channel.name.clone())
        .ok_or_else(|| EngineError("selected channel disappeared from inventory".into()))
}

fn lane_at(index: usize) -> Option<VocalLaneId> {
    [VocalLaneId::Mic1, VocalLaneId::Mic2, VocalLaneId::Mic3]
        .get(index)
        .copied()
}

pub fn run_virtual_calibration_wizard() -> Result<CalibrationWizardReport, EngineError> {
    let inventory = AsioChannelInventory {
        driver_name: "KING Virtual Qu-16 ASIO".into(),
        sample_rate: SAMPLE_RATE,
        physical_hardware: false,
        input_channels: vec![
            descriptor(2, "Virtual Mic Send A", AsioDirection::Input),
            descriptor(5, "Virtual Mic Send B", AsioDirection::Input),
            descriptor(9, "Virtual Mic Send C", AsioDirection::Input),
        ],
        output_channels: vec![
            descriptor(1, "Virtual Vocal Return A", AsioDirection::Output),
            descriptor(4, "Virtual Vocal Return B", AsioDirection::Output),
            descriptor(8, "Virtual Vocal Return C", AsioDirection::Output),
        ],
    };
    let mut wizard = CalibrationWizard::new_virtual(inventory)?;
    let lane_specs = [
        (VocalLaneId::Mic1, 2, 1),
        (VocalLaneId::Mic2, 5, 4),
        (VocalLaneId::Mic3, 9, 8),
    ];
    for (position, (lane, input, output)) in lane_specs.into_iter().enumerate() {
        wizard.start_lane(lane)?;
        for _ in 0..COUNTDOWN_TICKS {
            wizard.countdown_tick()?;
        }
        if position == 1 {
            let _ = wizard.observe(AsioDirection::Input, &[(5, -12.0), (9, -16.0)]);
        }
        wizard.observe(AsioDirection::Input, &[(input, -12.0), (99, -84.0)])?;
        wizard.observe(AsioDirection::Output, &[(output, -11.0), (98, -83.0)])?;
    }
    wizard.finish()
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

    fn wizard() -> CalibrationWizard {
        CalibrationWizard::new_virtual(AsioChannelInventory {
            driver_name: "Virtual".into(),
            sample_rate: SAMPLE_RATE,
            physical_hardware: false,
            input_channels: vec![descriptor(2, "Input A", AsioDirection::Input)],
            output_channels: vec![descriptor(1, "Return A", AsioDirection::Output)],
        })
        .unwrap()
    }

    #[test]
    fn observation_is_blocked_during_countdown() {
        let mut wizard = wizard();
        wizard.start_lane(VocalLaneId::Mic1).unwrap();
        assert!(wizard.observe(AsioDirection::Input, &[(2, -12.0)]).is_err());
        assert_eq!(wizard.state(), CalibrationState::Countdown);
    }

    #[test]
    fn only_one_lane_can_be_active_and_order_is_fixed() {
        let mut wizard = wizard();
        assert!(wizard.start_lane(VocalLaneId::Mic2).is_err());
        wizard.start_lane(VocalLaneId::Mic1).unwrap();
        assert!(wizard.start_lane(VocalLaneId::Mic1).is_err());
    }

    #[test]
    fn ambiguous_signal_does_not_advance_the_wizard() {
        let mut wizard = wizard();
        wizard.start_lane(VocalLaneId::Mic1).unwrap();
        for _ in 0..COUNTDOWN_TICKS {
            wizard.countdown_tick().unwrap();
        }
        assert!(wizard
            .observe(AsioDirection::Input, &[(2, -12.0), (3, -18.0)])
            .is_err());
        assert_eq!(wizard.state(), CalibrationState::TracingInput);
    }

    #[test]
    fn cancellation_is_terminal() {
        let mut wizard = wizard();
        wizard.start_lane(VocalLaneId::Mic1).unwrap();
        wizard.cancel();
        assert_eq!(wizard.state(), CalibrationState::Cancelled);
        assert!(wizard.start_lane(VocalLaneId::Mic1).is_err());
    }

    #[test]
    fn virtual_wizard_completes_with_rejection_evidence_but_never_hardware_ready() {
        let report = run_virtual_calibration_wizard().unwrap();
        assert_eq!(report.final_state, CalibrationState::Complete);
        assert_eq!(report.completed_lanes, 3);
        assert_eq!(report.rejected_observations, 1);
        assert!(!report.hardware_ready);
        assert!(!report.physical_audio_started);
        assert!(!report.qu16_writes_performed);
        assert!(report
            .routing_map
            .lanes
            .iter()
            .all(|route| route.evidence == RouteEvidence::VirtualSignalTrace));
    }
}
