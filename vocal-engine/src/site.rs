use crate::{
    preset::{three_microphone_plan, VocalLaneDefinition, VocalLaneId},
    AudioDeviceInventory,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationMode {
    #[default]
    Disarmed,
    InputMeterOnly,
    HeadphoneReturn,
    PaReturn,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationArmRequest {
    pub mode: CalibrationMode,
    pub lane: Option<VocalLaneId>,
    pub phantom_power_off_confirmed: bool,
    pub input_gain_safe_confirmed: bool,
    pub headphones_connected_confirmed: bool,
    pub main_pa_muted_confirmed: bool,
    pub dry_fallback_confirmed: bool,
    pub physical_return_route_confirmed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationGateDecision {
    pub allowed: bool,
    pub mode: CalibrationMode,
    pub lane: Option<VocalLaneId>,
    pub blockers: Vec<&'static str>,
}

pub fn evaluate_calibration_gate(request: &CalibrationArmRequest) -> CalibrationGateDecision {
    let mut blockers = Vec::new();
    if request.mode == CalibrationMode::Disarmed {
        return CalibrationGateDecision {
            allowed: true,
            mode: request.mode,
            lane: request.lane,
            blockers,
        };
    }
    if request.lane.is_none() {
        blockers.push("select_exactly_one_microphone_lane");
    }
    if !request.phantom_power_off_confirmed {
        blockers.push("confirm_48v_off_for_wireless_receiver");
    }
    if !request.input_gain_safe_confirmed {
        blockers.push("confirm_safe_input_gain");
    }
    match request.mode {
        CalibrationMode::Disarmed | CalibrationMode::InputMeterOnly => {}
        CalibrationMode::HeadphoneReturn => {
            if !request.headphones_connected_confirmed {
                blockers.push("connect_and_confirm_headphones");
            }
            if !request.main_pa_muted_confirmed {
                blockers.push("mute_main_pa_before_return_test");
            }
            if !request.physical_return_route_confirmed {
                blockers.push("confirm_dedicated_qu16_usb_return_route");
            }
        }
        CalibrationMode::PaReturn => {
            if !request.dry_fallback_confirmed {
                blockers.push("verify_direct_qu16_dry_fallback_first");
            }
            if !request.physical_return_route_confirmed {
                blockers.push("confirm_dedicated_qu16_usb_return_route");
            }
        }
    }
    CalibrationGateDecision {
        allowed: blockers.is_empty(),
        mode: request.mode,
        lane: request.lane,
        blockers,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalSiteReadinessReport {
    pub schema_version: u32,
    pub evidence_class: &'static str,
    pub audio_host: String,
    pub qu16_input_endpoints: Vec<String>,
    pub qu16_output_endpoints: Vec<String>,
    pub qu16_usb_audio_detected: bool,
    pub microphone_lanes: [VocalLaneDefinition; 3],
    pub current_mode: CalibrationMode,
    pub writes_performed: bool,
    pub audio_output_started: bool,
    pub readiness_blockers: Vec<&'static str>,
}

pub fn build_site_readiness(inventory: &AudioDeviceInventory) -> VocalSiteReadinessReport {
    let qu16_input_endpoints = inventory
        .input_devices
        .iter()
        .filter(|device| is_qu16_endpoint(&device.name))
        .map(|device| device.name.clone())
        .collect::<Vec<_>>();
    let qu16_output_endpoints = inventory
        .output_devices
        .iter()
        .filter(|device| is_qu16_endpoint(&device.name))
        .map(|device| device.name.clone())
        .collect::<Vec<_>>();
    let qu16_usb_audio_detected =
        !qu16_input_endpoints.is_empty() && !qu16_output_endpoints.is_empty();
    let mut readiness_blockers = Vec::new();
    if qu16_input_endpoints.is_empty() {
        readiness_blockers.push("qu16_usb_input_endpoint_not_detected");
    }
    if qu16_output_endpoints.is_empty() {
        readiness_blockers.push("qu16_usb_return_endpoint_not_detected");
    }
    readiness_blockers.extend([
        "qu16_usb_send_mapping_not_verified",
        "qu16_usb_return_mapping_not_verified",
        "direct_dry_fallback_not_verified",
        "physical_round_trip_not_measured",
        "uhf_receiver_model_and_outputs_not_verified",
    ]);
    VocalSiteReadinessReport {
        schema_version: 1,
        evidence_class: "read_only_device_inventory",
        audio_host: inventory.host.clone(),
        qu16_input_endpoints,
        qu16_output_endpoints,
        qu16_usb_audio_detected,
        microphone_lanes: three_microphone_plan(),
        current_mode: CalibrationMode::Disarmed,
        writes_performed: false,
        audio_output_started: false,
        readiness_blockers,
    }
}

fn is_qu16_endpoint(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("qu-16") || normalized.contains("qu 16")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AudioDeviceCapability;

    fn device(name: &str) -> AudioDeviceCapability {
        AudioDeviceCapability {
            name: name.into(),
            is_default: false,
            supports_48k_float32: true,
            channels_48k_float32: vec![2],
            buffer_size: "480-480 frames".into(),
        }
    }

    #[test]
    fn read_only_scan_requires_both_usb_directions() {
        let inventory = AudioDeviceInventory {
            host: "Wasapi".into(),
            input_devices: vec![device("Qu-16 Stereo Out (Qu-16)")],
            output_devices: vec![],
        };
        let report = build_site_readiness(&inventory);
        assert!(!report.qu16_usb_audio_detected);
        assert!(!report.writes_performed);
        assert!(!report.audio_output_started);
        assert!(report
            .readiness_blockers
            .contains(&"qu16_usb_return_endpoint_not_detected"));
    }

    #[test]
    fn meter_only_never_requires_an_output_route() {
        let request = CalibrationArmRequest {
            mode: CalibrationMode::InputMeterOnly,
            lane: Some(VocalLaneId::Mic1),
            phantom_power_off_confirmed: true,
            input_gain_safe_confirmed: true,
            ..CalibrationArmRequest::default()
        };
        assert!(evaluate_calibration_gate(&request).allowed);
    }

    #[test]
    fn headphone_return_is_blocked_until_every_safety_check_passes() {
        let request = CalibrationArmRequest {
            mode: CalibrationMode::HeadphoneReturn,
            lane: Some(VocalLaneId::Mic1),
            phantom_power_off_confirmed: true,
            input_gain_safe_confirmed: true,
            ..CalibrationArmRequest::default()
        };
        let decision = evaluate_calibration_gate(&request);
        assert!(!decision.allowed);
        assert_eq!(decision.blockers.len(), 3);
    }

    #[test]
    fn pa_return_requires_verified_dry_fallback() {
        let request = CalibrationArmRequest {
            mode: CalibrationMode::PaReturn,
            lane: Some(VocalLaneId::Mic1),
            phantom_power_off_confirmed: true,
            input_gain_safe_confirmed: true,
            physical_return_route_confirmed: true,
            ..CalibrationArmRequest::default()
        };
        assert_eq!(
            evaluate_calibration_gate(&request).blockers,
            vec!["verify_direct_qu16_dry_fallback_first"]
        );
    }
}
