use crate::{
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
    pub error: Option<String>,
}

pub struct VocalControlSession {
    controls: ThreeLanePresetBank,
    presets: [VocalPreset; 3],
    calibration_mode: CalibrationMode,
}

impl Default for VocalControlSession {
    fn default() -> Self {
        Self {
            controls: ThreeLanePresetBank::new(VocalPreset::Professional),
            presets: [VocalPreset::Professional; 3],
            calibration_mode: CalibrationMode::Disarmed,
        }
    }
}

impl VocalControlSession {
    pub fn handle(&mut self, request: VocalControlRequest) -> VocalControlResponse {
        let mut gate = None;
        match request.command {
            VocalControlCommand::Status => {}
            VocalControlCommand::SetPreset { lane, preset } => {
                self.controls.request(lane, preset);
                self.presets[lane_index(lane)] = preset;
            }
            VocalControlCommand::EvaluateArm { request } => {
                gate = Some(evaluate_calibration_gate(&request));
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
            error: None,
        }
    }

    pub fn error_response(&self, id: u64, error: impl Into<String>) -> VocalControlResponse {
        VocalControlResponse {
            id,
            ok: false,
            status: self.status(),
            gate: None,
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
}
