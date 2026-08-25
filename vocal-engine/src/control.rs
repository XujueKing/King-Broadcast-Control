use crate::{
    drift_runtime::{
        drift_runtime_telemetry_channel, DriftRuntimeTelemetryReceiver,
        DriftRuntimeTelemetrySnapshot,
    },
    failover::{failover_telemetry_channel, FailoverTelemetryReceiver, FailoverTelemetrySnapshot},
    output_gate::{conditions_from_runtime, OutputDecision, OutputGate, RuntimeOutputInputs},
    preset::{ThreeLanePresetBank, VocalLaneId, VocalPreset},
    site::{
        evaluate_calibration_gate, CalibrationArmRequest, CalibrationGateDecision, CalibrationMode,
    },
    EngineError,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum VocalControlCommand {
    Status,
    SetPreset {
        lane: VocalLaneId,
        preset: VocalPreset,
    },
    EvaluateArm {
        request: CalibrationArmRequest,
    },
    EvaluateOutputShadow {
        now_ms: u64,
        operator_requested: bool,
        route_verified: bool,
        dry_fallback_verified: bool,
        input_levels_fresh: bool,
        input_peaks_dbfs: [Option<f32>; 3],
    },
    Disarm,
}

#[derive(Clone, Debug, Deserialize)]
pub struct VocalControlRequest {
    pub id: u64,
    #[serde(flatten)]
    pub command: VocalControlCommand,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalLaneTelemetry {
    pub lane: VocalLaneId,
    pub preset: VocalPreset,
    pub input_peak_dbfs: Option<f32>,
    pub quality_score: Option<f32>,
    pub corrected_mix: Option<f32>,
    pub fresh: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalControlStatus {
    pub schema_version: u32,
    pub engine_state: &'static str,
    pub calibration_mode: CalibrationMode,
    pub physical_audio_started: bool,
    pub hardware_bound: bool,
    pub failover: FailoverTelemetrySnapshot,
    pub clock_drift: DriftRuntimeTelemetrySnapshot,
    pub lanes: [VocalLaneTelemetry; 3],
    pub message: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalControlResponse {
    pub id: u64,
    pub ok: bool,
    pub status: VocalControlStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate: Option<CalibrationGateDecision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_authorization: Option<OutputDecision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct VocalControlSession {
    controls: ThreeLanePresetBank,
    presets: [VocalPreset; 3],
    calibration_mode: CalibrationMode,
    failover: FailoverTelemetryReceiver,
    clock_drift: DriftRuntimeTelemetryReceiver,
    output_gate: OutputGate,
}

impl Default for VocalControlSession {
    fn default() -> Self {
        let (_, failover) = failover_telemetry_channel();
        let (_, clock_drift) = drift_runtime_telemetry_channel();
        Self {
            controls: ThreeLanePresetBank::new(VocalPreset::Professional),
            presets: [VocalPreset::Professional; 3],
            calibration_mode: CalibrationMode::Disarmed,
            failover,
            clock_drift,
            output_gate: OutputGate::default(),
        }
    }
}

impl VocalControlSession {
    pub fn with_failover_telemetry(failover: FailoverTelemetryReceiver) -> Self {
        Self {
            failover,
            ..Self::default()
        }
    }

    pub fn with_runtime_telemetry(
        failover: FailoverTelemetryReceiver,
        clock_drift: DriftRuntimeTelemetryReceiver,
    ) -> Self {
        Self {
            failover,
            clock_drift,
            ..Self::default()
        }
    }

    pub fn handle(&mut self, request: VocalControlRequest) -> VocalControlResponse {
        let mut gate = None;
        let mut output_authorization = None;
        match request.command {
            VocalControlCommand::Status => {}
            VocalControlCommand::SetPreset { lane, preset } => {
                self.controls.request(lane, preset);
                self.presets[lane_index(lane)] = preset;
            }
            VocalControlCommand::EvaluateArm { request } => {
                gate = Some(evaluate_calibration_gate(&request));
            }
            VocalControlCommand::EvaluateOutputShadow {
                now_ms,
                operator_requested,
                route_verified,
                dry_fallback_verified,
                input_levels_fresh,
                input_peaks_dbfs,
            } => {
                let conditions = conditions_from_runtime(
                    RuntimeOutputInputs {
                        operator_requested,
                        route_verified,
                        dry_fallback_verified,
                        input_levels_fresh,
                        input_peaks_dbfs,
                    },
                    &self.clock_drift.snapshot(),
                    &self.failover.snapshot(),
                );
                output_authorization = Some(self.output_gate.evaluate(&conditions, now_ms));
            }
            VocalControlCommand::Disarm => {
                self.calibration_mode = CalibrationMode::Disarmed;
            }
        }
        VocalControlResponse {
            id: request.id,
            ok: true,
            status: self.status(),
            gate,
            output_authorization,
            error: None,
        }
    }

    pub fn error_response(&self, id: u64, error: impl Into<String>) -> VocalControlResponse {
        VocalControlResponse {
            id,
            ok: false,
            status: self.status(),
            gate: None,
            output_authorization: None,
            error: Some(error.into()),
        }
    }

    pub fn status(&self) -> VocalControlStatus {
        let lanes = [VocalLaneId::Mic1, VocalLaneId::Mic2, VocalLaneId::Mic3];
        VocalControlStatus {
            schema_version: 1,
            engine_state: "control_only_disarmed",
            calibration_mode: self.calibration_mode,
            physical_audio_started: false,
            hardware_bound: false,
            failover: self.failover.snapshot(),
            clock_drift: self.clock_drift.snapshot(),
            lanes: std::array::from_fn(|index| VocalLaneTelemetry {
                lane: lanes[index],
                preset: self.presets[index],
                input_peak_dbfs: None,
                quality_score: None,
                corrected_mix: None,
                fresh: false,
            }),
            message: "离线控制桥已连接；Qu-16 ASIO 未绑定，未启动物理音频",
        }
    }
}

pub fn serve_control_lines(input: impl BufRead, mut output: impl Write) -> Result<(), EngineError> {
    let mut session = VocalControlSession::default();
    for line in input.lines() {
        let line = line.map_err(|error| EngineError(format!("读取控制请求失败：{error}")))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<VocalControlRequest>(&line) {
            Ok(request) => session.handle(request),
            Err(error) => session.error_response(0, format!("控制请求无效：{error}")),
        };
        serde_json::to_writer(&mut output, &response)
            .map_err(|error| EngineError(format!("编码控制响应失败：{error}")))?;
        output
            .write_all(b"\n")
            .map_err(|error| EngineError(format!("写入控制响应失败：{error}")))?;
        output
            .flush()
            .map_err(|error| EngineError(format!("刷新控制响应失败：{error}")))?;
    }
    Ok(())
}

fn lane_index(lane: VocalLaneId) -> usize {
    match lane {
        VocalLaneId::Mic1 => 0,
        VocalLaneId::Mic2 => 1,
        VocalLaneId::Mic3 => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn set_preset_changes_only_the_requested_lane() {
        let mut session = VocalControlSession::default();
        let response = session.handle(VocalControlRequest {
            id: 7,
            command: VocalControlCommand::SetPreset {
                lane: VocalLaneId::Mic2,
                preset: VocalPreset::Strong,
            },
        });
        assert_eq!(response.id, 7);
        assert_eq!(response.status.lanes[0].preset, VocalPreset::Professional);
        assert_eq!(response.status.lanes[1].preset, VocalPreset::Strong);
        assert_eq!(response.status.lanes[2].preset, VocalPreset::Professional);
        assert!(!response.status.physical_audio_started);
    }

    #[test]
    fn stdio_protocol_is_newline_delimited_and_recovers_from_bad_json() {
        let input = Cursor::new(b"{bad json}\n{\"id\":2,\"command\":\"status\"}\n".to_vec());
        let mut output = Vec::new();
        serve_control_lines(input, &mut output).unwrap();
        let responses = String::from_utf8(output).unwrap();
        let lines = responses.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["ok"], false);
        assert_eq!(second["id"], 2);
        assert_eq!(second["status"]["engineState"], "control_only_disarmed");
    }

    #[test]
    fn offline_bridge_never_arms_audio_from_an_evaluation() {
        let mut session = VocalControlSession::default();
        let response = session.handle(VocalControlRequest {
            id: 1,
            command: VocalControlCommand::EvaluateArm {
                request: CalibrationArmRequest {
                    mode: CalibrationMode::InputMeterOnly,
                    lane: Some(VocalLaneId::Mic1),
                    phantom_power_off_confirmed: true,
                    input_gain_safe_confirmed: true,
                    ..CalibrationArmRequest::default()
                },
            },
        });
        assert!(response.gate.unwrap().allowed);
        assert_eq!(response.status.calibration_mode, CalibrationMode::Disarmed);
        assert!(!response.status.physical_audio_started);
    }

    #[test]
    fn status_reads_failover_telemetry_without_locking_the_audio_path() {
        use crate::failover::{FailoverReason, FailoverRuntimeState};
        let (publisher, receiver) = failover_telemetry_channel();
        let session = VocalControlSession::with_failover_telemetry(receiver);
        publisher.publish(
            FailoverRuntimeState::DryFallback,
            Some(FailoverReason::EngineTimeout),
        );
        let snapshot = session.status().failover;
        assert_eq!(snapshot.state, FailoverRuntimeState::DryFallback);
        assert_eq!(snapshot.reason, Some(FailoverReason::EngineTimeout));
        assert!(snapshot.using_dry_fallback);
        assert!(snapshot.fresh);
    }

    #[test]
    fn status_polls_bounded_clock_drift_telemetry() {
        use crate::{
            capture::MeterFrame,
            drift_runtime::{drift_runtime_telemetry_channel, DriftRuntimeController},
            routing::AsioDirection,
        };
        let (failover_publisher, failover_receiver) = failover_telemetry_channel();
        drop(failover_publisher);
        let (drift_publisher, drift_receiver) = drift_runtime_telemetry_channel();
        let mut runtime = DriftRuntimeController::new(drift_publisher);
        for index in 0..6_u64 {
            let position = 1_000_000 + index * 480_000;
            let input = MeterFrame {
                sequence: index + 1,
                frame_position: position,
                direction: AsioDirection::Input,
                peaks: Vec::new(),
            };
            let returned = MeterFrame {
                sequence: index + 1,
                frame_position: position + 120 + index * 24,
                direction: AsioDirection::Output,
                peaks: Vec::new(),
            };
            runtime.ingest_input(input, index, index).unwrap();
            runtime.ingest_return(1, returned, index, index).unwrap();
        }
        let session =
            VocalControlSession::with_runtime_telemetry(failover_receiver, drift_receiver);
        let snapshot = session.status().clock_drift;
        assert_eq!(
            snapshot.state,
            crate::drift_runtime::DriftRuntimeState::Locked
        );
        assert!(snapshot.bounded_snapshot);
        assert!(!snapshot.hardware_ready);
    }

    #[test]
    fn shadow_output_uses_runtime_clock_and_failover_snapshots() {
        use crate::{
            capture::MeterFrame,
            drift_runtime::{drift_runtime_telemetry_channel, DriftRuntimeController},
            failover::{FailoverReason, FailoverRuntimeState},
            routing::AsioDirection,
        };
        let (failover_publisher, failover_receiver) = failover_telemetry_channel();
        let (drift_publisher, drift_receiver) = drift_runtime_telemetry_channel();
        let mut runtime = DriftRuntimeController::new(drift_publisher);
        for index in 0..6_u64 {
            let position = 1_000_000 + index * 480_000;
            runtime
                .ingest_input(
                    MeterFrame {
                        sequence: index + 1,
                        frame_position: position,
                        direction: AsioDirection::Input,
                        peaks: Vec::new(),
                    },
                    index,
                    index,
                )
                .unwrap();
            runtime
                .ingest_return(
                    1,
                    MeterFrame {
                        sequence: index + 1,
                        frame_position: position + 120 + index * 24,
                        direction: AsioDirection::Output,
                        peaks: Vec::new(),
                    },
                    index,
                    index,
                )
                .unwrap();
        }
        failover_publisher.publish(FailoverRuntimeState::Processed, None);
        let mut session =
            VocalControlSession::with_runtime_telemetry(failover_receiver, drift_receiver);
        let request = |id, now_ms| VocalControlRequest {
            id,
            command: VocalControlCommand::EvaluateOutputShadow {
                now_ms,
                operator_requested: true,
                route_verified: true,
                dry_fallback_verified: true,
                input_levels_fresh: true,
                input_peaks_dbfs: [Some(-12.0); 3],
            },
        };
        let authorized = session.handle(request(1, 100));
        let authorization_id = authorized
            .output_authorization
            .unwrap()
            .authorization
            .unwrap()
            .id;

        failover_publisher.publish(
            FailoverRuntimeState::DryFallback,
            Some(FailoverReason::ControlBridgeDisconnect),
        );
        let revoked = session
            .handle(request(2, 101))
            .output_authorization
            .unwrap();
        assert_eq!(revoked.revoked_id, Some(authorization_id));
        assert_eq!(
            revoked.blockers,
            vec![crate::output_gate::OutputBlocker::ControlPathUnhealthy]
        );
        assert!(!revoked.physical_output_started);
    }
}
