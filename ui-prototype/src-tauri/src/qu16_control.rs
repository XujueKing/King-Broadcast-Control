//! Allen & Heath Qu-16 semantic control protocol.
//!
//! This module is intentionally independent of Tauri and of the TCP worker. It
//! exposes only commands that are safe for the Qu-16 UI to issue; callers cannot
//! supply an arbitrary NRPN parameter ID. In particular, the protocol's remote
//! shutdown parameter (`0x5F`) is not representable by [`Qu16ControlCommand`].
//!
//! Protocol source: Qu MIDI Protocol V1.9+ ISS.2, pages 3, 5-8, 10 and 13.

use serde::{Deserialize, Serialize};
use std::{array, fmt};

const NRPN_MSB_CONTROLLER: u8 = 0x63;
const NRPN_LSB_CONTROLLER: u8 = 0x62;
const DATA_ENTRY_MSB_CONTROLLER: u8 = 0x06;
const DATA_ENTRY_LSB_CONTROLLER: u8 = 0x26;

const FADER_PARAMETER_ID: u8 = 0x17;
const PAN_PARAMETER_ID: u8 = 0x16;
const LR_ASSIGN_PARAMETER_ID: u8 = 0x18;
const SEND_LEVEL_PARAMETER_ID: u8 = 0x20;
const MIX_PRE_POST_PARAMETER_ID: u8 = 0x50;
const PAFL_PARAMETER_ID: u8 = 0x51;
const MIX_ASSIGN_PARAMETER_ID: u8 = 0x55;
const FIXED_INDEX: u8 = 0x07;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Qu16ParameterValueKind {
    SevenBit,
    Binary,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Qu16ProcessingParameter {
    key: &'static str,
    parameter_id: u8,
    index: u8,
    value_kind: Qu16ParameterValueKind,
}

// Every item is named by UI semantics and maps to one documented Qu NRPN.
// Keeping this table private prevents callers from reaching Remote Shutdown
// (0x5F) or any undocumented parameter by supplying a raw ID.
const QU16_PROCESSING_PARAMETERS: [Qu16ProcessingParameter; 33] = [
    Qu16ProcessingParameter {
        key: "usb-source",
        parameter_id: 0x12,
        index: 0x00,
        value_kind: Qu16ParameterValueKind::Binary,
    },
    Qu16ProcessingParameter {
        key: "preamp-source",
        parameter_id: 0x57,
        index: 0x00,
        value_kind: Qu16ParameterValueKind::Binary,
    },
    Qu16ProcessingParameter {
        key: "preamp-gain",
        parameter_id: 0x19,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "digital-trim",
        parameter_id: 0x52,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "stereo-trim",
        parameter_id: 0x54,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "polarity",
        parameter_id: 0x6A,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::Binary,
    },
    Qu16ProcessingParameter {
        key: "hpf-frequency",
        parameter_id: 0x13,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "hpf-in",
        parameter_id: 0x14,
        index: 0x00,
        value_kind: Qu16ParameterValueKind::Binary,
    },
    Qu16ProcessingParameter {
        key: "peq-lf-gain",
        parameter_id: 0x01,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-lf-frequency",
        parameter_id: 0x02,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-lf-width",
        parameter_id: 0x03,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-lm-gain",
        parameter_id: 0x05,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-lm-frequency",
        parameter_id: 0x06,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-lm-width",
        parameter_id: 0x07,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-hm-gain",
        parameter_id: 0x09,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-hm-frequency",
        parameter_id: 0x0A,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-hm-width",
        parameter_id: 0x0B,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-hf-gain",
        parameter_id: 0x0D,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-hf-frequency",
        parameter_id: 0x0E,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-hf-width",
        parameter_id: 0x0F,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "peq-in",
        parameter_id: 0x11,
        index: 0x00,
        value_kind: Qu16ParameterValueKind::Binary,
    },
    Qu16ProcessingParameter {
        key: "gate-attack",
        parameter_id: 0x41,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "gate-release",
        parameter_id: 0x42,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "gate-hold",
        parameter_id: 0x43,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "gate-threshold",
        parameter_id: 0x44,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "gate-depth",
        parameter_id: 0x45,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "gate-in",
        parameter_id: 0x46,
        index: 0x00,
        value_kind: Qu16ParameterValueKind::Binary,
    },
    Qu16ProcessingParameter {
        key: "comp-attack",
        parameter_id: 0x62,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "comp-release",
        parameter_id: 0x63,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "comp-ratio",
        parameter_id: 0x65,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "comp-threshold",
        parameter_id: 0x66,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "comp-gain",
        parameter_id: 0x67,
        index: FIXED_INDEX,
        value_kind: Qu16ParameterValueKind::SevenBit,
    },
    Qu16ProcessingParameter {
        key: "comp-in",
        parameter_id: 0x68,
        index: 0x00,
        value_kind: Qu16ParameterValueKind::Binary,
    },
];

const NOTE_ON_STATUS: u8 = 0x90;
const CONTROL_CHANGE_STATUS: u8 = 0xB0;
const SYSEX_START: u8 = 0xF0;
const SYSEX_END: u8 = 0xF7;
const DEFAULT_MAX_SYSEX_BYTES: usize = 4_096;

/// Physical/audio-core role of a target exposed by the current Qu-16 UI.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Qu16TargetRole {
    Source,
    Master,
}

/// A strict mapping from one stable UI entity ID to the Qu protocol `CH` byte.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16Target {
    pub ui_id: &'static str,
    pub channel_number: u8,
    pub role: Qu16TargetRole,
}

const QU16_TARGETS: [Qu16Target; 33] = [
    Qu16Target {
        ui_id: "ch-1",
        channel_number: 0x20,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-2",
        channel_number: 0x21,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-3",
        channel_number: 0x22,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-4",
        channel_number: 0x23,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-5",
        channel_number: 0x24,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-6",
        channel_number: 0x25,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-7",
        channel_number: 0x26,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-8",
        channel_number: 0x27,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-9",
        channel_number: 0x28,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-10",
        channel_number: 0x29,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-11",
        channel_number: 0x2A,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-12",
        channel_number: 0x2B,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-13",
        channel_number: 0x2C,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-14",
        channel_number: 0x2D,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-15",
        channel_number: 0x2E,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "ch-16",
        channel_number: 0x2F,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "st-1",
        channel_number: 0x40,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "st-2",
        channel_number: 0x41,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "st-3",
        channel_number: 0x42,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "fx-1-ret",
        channel_number: 0x08,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "fx-2-ret",
        channel_number: 0x09,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "fx-3-ret",
        channel_number: 0x0A,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "fx-4-ret",
        channel_number: 0x0B,
        role: Qu16TargetRole::Source,
    },
    Qu16Target {
        ui_id: "fx-1-send",
        channel_number: 0x00,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "fx-2-send",
        channel_number: 0x01,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "mix-1-master",
        channel_number: 0x60,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "mix-2-master",
        channel_number: 0x61,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "mix-3-master",
        channel_number: 0x62,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "mix-4-master",
        channel_number: 0x63,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "mix-5-6-master",
        channel_number: 0x64,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "mix-7-8-master",
        channel_number: 0x65,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "mix-9-10-master",
        channel_number: 0x66,
        role: Qu16TargetRole::Master,
    },
    Qu16Target {
        ui_id: "lr-master",
        channel_number: 0x67,
        role: Qu16TargetRole::Master,
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Qu16SendBus {
    label: &'static str,
    index: u8,
}

const QU16_SEND_BUSES: [Qu16SendBus; 9] = [
    Qu16SendBus {
        label: "Mix 1",
        index: 0x00,
    },
    Qu16SendBus {
        label: "Mix 2",
        index: 0x01,
    },
    Qu16SendBus {
        label: "Mix 3",
        index: 0x02,
    },
    Qu16SendBus {
        label: "Mix 4",
        index: 0x03,
    },
    Qu16SendBus {
        label: "Mix 5-6",
        index: 0x04,
    },
    Qu16SendBus {
        label: "Mix 7-8",
        index: 0x05,
    },
    Qu16SendBus {
        label: "Mix 9-10",
        index: 0x06,
    },
    Qu16SendBus {
        label: "FX 1",
        index: 0x10,
    },
    Qu16SendBus {
        label: "FX 2",
        index: 0x11,
    },
];

pub fn target_from_ui_id(ui_id: &str) -> Option<&'static Qu16Target> {
    QU16_TARGETS.iter().find(|target| target.ui_id == ui_id)
}

pub fn target_from_channel_number(channel_number: u8) -> Option<&'static Qu16Target> {
    QU16_TARGETS
        .iter()
        .find(|target| target.channel_number == channel_number)
}

fn send_bus_from_label(label: &str) -> Option<&'static Qu16SendBus> {
    QU16_SEND_BUSES.iter().find(|bus| bus.label == label)
}

fn send_bus_from_index(index: u8) -> Option<&'static Qu16SendBus> {
    QU16_SEND_BUSES.iter().find(|bus| bus.index == index)
}

fn processing_parameter_from_key(key: &str) -> Option<&'static Qu16ProcessingParameter> {
    QU16_PROCESSING_PARAMETERS
        .iter()
        .find(|parameter| parameter.key == key)
}

fn processing_parameter_from_wire(
    parameter_id: u8,
    index: u8,
) -> Option<&'static Qu16ProcessingParameter> {
    QU16_PROCESSING_PARAMETERS
        .iter()
        .find(|parameter| parameter.parameter_id == parameter_id && parameter.index == index)
}

fn pan_bus_from_label(label: &str) -> Option<u8> {
    match label {
        "Mix 5-6" => Some(0x04),
        "Mix 7-8" => Some(0x05),
        "Mix 9-10" => Some(0x06),
        "LR" => Some(0x07),
        _ => None,
    }
}

fn pan_bus_from_index(index: u8) -> Option<&'static str> {
    match index {
        0x04 => Some("Mix 5-6"),
        0x05 => Some("Mix 7-8"),
        0x06 => Some("Mix 9-10"),
        0x07 => Some("LR"),
        _ => None,
    }
}

fn assign_bus_from_label(label: &str) -> Option<(u8, u8)> {
    if label == "LR" {
        Some((LR_ASSIGN_PARAMETER_ID, FIXED_INDEX))
    } else {
        send_bus_from_label(label).map(|bus| (MIX_ASSIGN_PARAMETER_ID, bus.index))
    }
}

fn assign_bus_from_wire(parameter_id: u8, index: u8) -> Option<&'static str> {
    if parameter_id == LR_ASSIGN_PARAMETER_ID && index == FIXED_INDEX {
        Some("LR")
    } else if parameter_id == MIX_ASSIGN_PARAMETER_ID {
        send_bus_from_index(index).map(|bus| bus.label)
    } else {
        None
    }
}

/// Safe semantic operations accepted from the Qu-16 digital-twin UI.
///
/// `value` is the exact 7-bit protocol value (`0..=127`), not a dB value and
/// not the UI's percentage. Conversion belongs in a separately tested codec.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Qu16ControlCommand {
    Fader {
        #[serde(rename = "targetId")]
        target_id: String,
        value: u8,
    },
    SendLevel {
        #[serde(rename = "targetId")]
        target_id: String,
        mix: String,
        value: u8,
    },
    Mute {
        #[serde(rename = "targetId")]
        target_id: String,
        muted: bool,
    },
    Pafl {
        #[serde(rename = "targetId")]
        target_id: String,
        enabled: bool,
    },
    Pan {
        #[serde(rename = "targetId")]
        target_id: String,
        mix: String,
        value: u8,
    },
    Assign {
        #[serde(rename = "targetId")]
        target_id: String,
        mix: String,
        assigned: bool,
    },
    PreFade {
        #[serde(rename = "targetId")]
        target_id: String,
        mix: String,
        pre: bool,
    },
    Processing {
        #[serde(rename = "targetId")]
        target_id: String,
        parameter: String,
        value: u8,
    },
}

impl Qu16ControlCommand {
    pub fn encode(&self, midi_channel: u8) -> Result<Vec<u8>, Qu16ControlError> {
        encode_control_command(midi_channel, self)
    }

    /// Returns the exact frontend cache key and raw value expected back from
    /// the mixer's authoritative readback. This deliberately shares the same
    /// whitelist as encoding so runtime code never has to reconstruct keys.
    pub fn expected_parameter(&self) -> Result<Qu16ExpectedParameter, Qu16ControlError> {
        expected_parameter(self)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16ExpectedParameter {
    pub key: String,
    pub value: u8,
}

/// Wire-safe frontend write. The key is semantic and canonical; there is no
/// representation for a raw Qu channel number or NRPN parameter identifier.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Qu16ParameterWrite {
    pub key: String,
    pub value: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Qu16ControlError {
    InvalidMidiChannel(u8),
    NonSevenBitValue(u8),
    UnknownTarget(String),
    UnknownSendBus(String),
    UnknownPanBus(String),
    UnknownProcessingParameter(String),
    SendRequiresSource(String),
    InvalidParameterKey(String),
    InvalidBinaryValue { key: String, value: u8 },
}

impl fmt::Display for Qu16ControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMidiChannel(channel) => {
                write!(formatter, "MIDI channel {channel} is outside 0..15")
            }
            Self::NonSevenBitValue(value) => {
                write!(formatter, "control value {value} is outside 0..127")
            }
            Self::UnknownTarget(target) => write!(formatter, "unknown Qu-16 UI target: {target}"),
            Self::UnknownSendBus(bus) => write!(formatter, "unknown Qu-16 send bus: {bus}"),
            Self::UnknownPanBus(bus) => write!(formatter, "unknown Qu-16 pan bus: {bus}"),
            Self::UnknownProcessingParameter(parameter) => {
                write!(formatter, "unknown Qu-16 processing parameter: {parameter}")
            }
            Self::SendRequiresSource(target) => {
                write!(
                    formatter,
                    "Qu-16 send level requires an input source: {target}"
                )
            }
            Self::InvalidParameterKey(key) => {
                write!(
                    formatter,
                    "invalid or non-canonical Qu-16 parameter key: {key}"
                )
            }
            Self::InvalidBinaryValue { key, value } => {
                write!(
                    formatter,
                    "Qu-16 binary parameter {key} requires 0 or 1, got {value}"
                )
            }
        }
    }
}

impl std::error::Error for Qu16ControlError {}

pub fn encode_control_command(
    midi_channel: u8,
    command: &Qu16ControlCommand,
) -> Result<Vec<u8>, Qu16ControlError> {
    validate_midi_channel(midi_channel)?;
    match command {
        Qu16ControlCommand::Fader { target_id, value } => {
            let target = require_target(target_id)?;
            validate_seven_bit(*value)?;
            Ok(encode_whitelisted_nrpn(
                midi_channel,
                target.channel_number,
                FADER_PARAMETER_ID,
                *value,
                FIXED_INDEX,
            ))
        }
        Qu16ControlCommand::SendLevel {
            target_id,
            mix,
            value,
        } => {
            let target = require_target(target_id)?;
            if target.role != Qu16TargetRole::Source {
                return Err(Qu16ControlError::SendRequiresSource(target_id.clone()));
            }
            let bus = send_bus_from_label(mix)
                .ok_or_else(|| Qu16ControlError::UnknownSendBus(mix.clone()))?;
            validate_seven_bit(*value)?;
            Ok(encode_whitelisted_nrpn(
                midi_channel,
                target.channel_number,
                SEND_LEVEL_PARAMETER_ID,
                *value,
                bus.index,
            ))
        }
        Qu16ControlCommand::Mute { target_id, muted } => {
            let target = require_target(target_id)?;
            let status = NOTE_ON_STATUS | midi_channel;
            let velocity = if *muted { 0x7F } else { 0x3F };
            // The Qu protocol spells its terminating NOTE OFF as NOTE ON with
            // velocity zero. Repeat the full status byte; do not depend on
            // running status for commands sent to the mixer.
            Ok(vec![
                status,
                target.channel_number,
                velocity,
                status,
                target.channel_number,
                0x00,
            ])
        }
        Qu16ControlCommand::Pafl { target_id, enabled } => {
            let target = require_target(target_id)?;
            Ok(encode_whitelisted_nrpn(
                midi_channel,
                target.channel_number,
                PAFL_PARAMETER_ID,
                u8::from(*enabled),
                FIXED_INDEX,
            ))
        }
        Qu16ControlCommand::Pan {
            target_id,
            mix,
            value,
        } => {
            let target = require_target(target_id)?;
            let index = pan_bus_from_label(mix)
                .ok_or_else(|| Qu16ControlError::UnknownPanBus(mix.clone()))?;
            if *value > 0x4A {
                return Err(Qu16ControlError::NonSevenBitValue(*value));
            }
            Ok(encode_whitelisted_nrpn(
                midi_channel,
                target.channel_number,
                PAN_PARAMETER_ID,
                *value,
                index,
            ))
        }
        Qu16ControlCommand::Assign {
            target_id,
            mix,
            assigned,
        } => {
            let target = require_target(target_id)?;
            if target.role != Qu16TargetRole::Source {
                return Err(Qu16ControlError::SendRequiresSource(target_id.clone()));
            }
            let (parameter_id, index) = assign_bus_from_label(mix)
                .ok_or_else(|| Qu16ControlError::UnknownSendBus(mix.clone()))?;
            Ok(encode_whitelisted_nrpn(
                midi_channel,
                target.channel_number,
                parameter_id,
                u8::from(*assigned),
                index,
            ))
        }
        Qu16ControlCommand::PreFade {
            target_id,
            mix,
            pre,
        } => {
            let target = require_target(target_id)?;
            if target.role != Qu16TargetRole::Source {
                return Err(Qu16ControlError::SendRequiresSource(target_id.clone()));
            }
            let bus = send_bus_from_label(mix)
                .ok_or_else(|| Qu16ControlError::UnknownSendBus(mix.clone()))?;
            Ok(encode_whitelisted_nrpn(
                midi_channel,
                target.channel_number,
                MIX_PRE_POST_PARAMETER_ID,
                u8::from(*pre),
                bus.index,
            ))
        }
        Qu16ControlCommand::Processing {
            target_id,
            parameter,
            value,
        } => {
            let target = require_target(target_id)?;
            let spec = processing_parameter_from_key(parameter)
                .ok_or_else(|| Qu16ControlError::UnknownProcessingParameter(parameter.clone()))?;
            match spec.value_kind {
                Qu16ParameterValueKind::SevenBit => validate_seven_bit(*value)?,
                Qu16ParameterValueKind::Binary if *value <= 1 => {}
                Qu16ParameterValueKind::Binary => {
                    return Err(Qu16ControlError::InvalidBinaryValue {
                        key: format!("process:{target_id}:{parameter}"),
                        value: *value,
                    })
                }
            }
            Ok(encode_whitelisted_nrpn(
                midi_channel,
                target.channel_number,
                spec.parameter_id,
                *value,
                spec.index,
            ))
        }
    }
}

pub fn command_from_parameter_write(
    write: &Qu16ParameterWrite,
) -> Result<Qu16ControlCommand, Qu16ControlError> {
    let parts: Vec<&str> = write.key.split(':').collect();
    let command = match parts.as_slice() {
        ["fader", target_id] => Qu16ControlCommand::Fader {
            target_id: (*target_id).to_string(),
            value: write.value,
        },
        ["send", target_id, mix] => Qu16ControlCommand::SendLevel {
            target_id: (*target_id).to_string(),
            mix: (*mix).to_string(),
            value: write.value,
        },
        ["mute", target_id] if write.value <= 1 => Qu16ControlCommand::Mute {
            target_id: (*target_id).to_string(),
            muted: write.value == 1,
        },
        ["pafl", target_id] if write.value <= 1 => Qu16ControlCommand::Pafl {
            target_id: (*target_id).to_string(),
            enabled: write.value == 1,
        },
        ["pan", target_id, mix] if write.value <= 0x4A => Qu16ControlCommand::Pan {
            target_id: (*target_id).to_string(),
            mix: (*mix).to_string(),
            value: write.value,
        },
        ["assign", target_id, mix] if write.value <= 1 => Qu16ControlCommand::Assign {
            target_id: (*target_id).to_string(),
            mix: (*mix).to_string(),
            assigned: write.value == 1,
        },
        ["pre", target_id, mix] if write.value <= 1 => Qu16ControlCommand::PreFade {
            target_id: (*target_id).to_string(),
            mix: (*mix).to_string(),
            pre: write.value == 1,
        },
        ["process", target_id, parameter] => Qu16ControlCommand::Processing {
            target_id: (*target_id).to_string(),
            parameter: (*parameter).to_string(),
            value: write.value,
        },
        ["mute" | "pafl", _] | ["assign" | "pre", _, _] => {
            return Err(Qu16ControlError::InvalidBinaryValue {
                key: write.key.clone(),
                value: write.value,
            })
        }
        _ => return Err(Qu16ControlError::InvalidParameterKey(write.key.clone())),
    };

    // Validate the complete semantic mapping and canonical spelling now, so a
    // batch can be rejected atomically before any item reaches the TCP worker.
    command.expected_parameter()?;
    command.encode(0)?;
    Ok(command)
}

fn expected_parameter(
    command: &Qu16ControlCommand,
) -> Result<Qu16ExpectedParameter, Qu16ControlError> {
    match command {
        Qu16ControlCommand::Fader { target_id, value } => {
            require_target(target_id)?;
            validate_seven_bit(*value)?;
            Ok(Qu16ExpectedParameter {
                key: format!("fader:{target_id}"),
                value: *value,
            })
        }
        Qu16ControlCommand::SendLevel {
            target_id,
            mix,
            value,
        } => {
            let target = require_target(target_id)?;
            if target.role != Qu16TargetRole::Source {
                return Err(Qu16ControlError::SendRequiresSource(target_id.clone()));
            }
            send_bus_from_label(mix)
                .ok_or_else(|| Qu16ControlError::UnknownSendBus(mix.clone()))?;
            validate_seven_bit(*value)?;
            Ok(Qu16ExpectedParameter {
                key: format!("send:{target_id}:{mix}"),
                value: *value,
            })
        }
        Qu16ControlCommand::Mute { target_id, muted } => {
            require_target(target_id)?;
            Ok(Qu16ExpectedParameter {
                key: format!("mute:{target_id}"),
                value: u8::from(*muted),
            })
        }
        Qu16ControlCommand::Pafl { target_id, enabled } => {
            require_target(target_id)?;
            Ok(Qu16ExpectedParameter {
                key: format!("pafl:{target_id}"),
                value: u8::from(*enabled),
            })
        }
        Qu16ControlCommand::Pan {
            target_id,
            mix,
            value,
        } => {
            require_target(target_id)?;
            pan_bus_from_label(mix).ok_or_else(|| Qu16ControlError::UnknownPanBus(mix.clone()))?;
            if *value > 0x4A {
                return Err(Qu16ControlError::NonSevenBitValue(*value));
            }
            Ok(Qu16ExpectedParameter {
                key: format!("pan:{target_id}:{mix}"),
                value: *value,
            })
        }
        Qu16ControlCommand::Assign {
            target_id,
            mix,
            assigned,
        } => {
            let target = require_target(target_id)?;
            if target.role != Qu16TargetRole::Source {
                return Err(Qu16ControlError::SendRequiresSource(target_id.clone()));
            }
            assign_bus_from_label(mix)
                .ok_or_else(|| Qu16ControlError::UnknownSendBus(mix.clone()))?;
            Ok(Qu16ExpectedParameter {
                key: format!("assign:{target_id}:{mix}"),
                value: u8::from(*assigned),
            })
        }
        Qu16ControlCommand::PreFade {
            target_id,
            mix,
            pre,
        } => {
            let target = require_target(target_id)?;
            if target.role != Qu16TargetRole::Source {
                return Err(Qu16ControlError::SendRequiresSource(target_id.clone()));
            }
            send_bus_from_label(mix)
                .ok_or_else(|| Qu16ControlError::UnknownSendBus(mix.clone()))?;
            Ok(Qu16ExpectedParameter {
                key: format!("pre:{target_id}:{mix}"),
                value: u8::from(*pre),
            })
        }
        Qu16ControlCommand::Processing {
            target_id,
            parameter,
            value,
        } => {
            require_target(target_id)?;
            let spec = processing_parameter_from_key(parameter)
                .ok_or_else(|| Qu16ControlError::UnknownProcessingParameter(parameter.clone()))?;
            match spec.value_kind {
                Qu16ParameterValueKind::SevenBit => validate_seven_bit(*value)?,
                Qu16ParameterValueKind::Binary if *value <= 1 => {}
                Qu16ParameterValueKind::Binary => {
                    return Err(Qu16ControlError::InvalidBinaryValue {
                        key: format!("process:{target_id}:{parameter}"),
                        value: *value,
                    })
                }
            }
            Ok(Qu16ExpectedParameter {
                key: format!("process:{target_id}:{parameter}"),
                value: *value,
            })
        }
    }
}

fn require_target(target_id: &str) -> Result<&'static Qu16Target, Qu16ControlError> {
    target_from_ui_id(target_id)
        .ok_or_else(|| Qu16ControlError::UnknownTarget(target_id.to_string()))
}

fn validate_midi_channel(midi_channel: u8) -> Result<(), Qu16ControlError> {
    if midi_channel <= 0x0F {
        Ok(())
    } else {
        Err(Qu16ControlError::InvalidMidiChannel(midi_channel))
    }
}

fn validate_seven_bit(value: u8) -> Result<(), Qu16ControlError> {
    if value <= 0x7F {
        Ok(())
    } else {
        Err(Qu16ControlError::NonSevenBitValue(value))
    }
}

/// Private by design: there is no public raw-ID encoder.
fn encode_whitelisted_nrpn(
    midi_channel: u8,
    channel_number: u8,
    parameter_id: u8,
    value: u8,
    index: u8,
) -> Vec<u8> {
    debug_assert!(midi_channel <= 0x0F);
    debug_assert!(channel_number <= 0x7F);
    debug_assert!(parameter_id != 0x5F, "remote shutdown is never whitelisted");
    debug_assert!(value <= 0x7F);
    debug_assert!(index <= 0x7F);
    let status = CONTROL_CHANGE_STATUS | midi_channel;
    vec![
        status,
        NRPN_MSB_CONTROLLER,
        channel_number,
        status,
        NRPN_LSB_CONTROLLER,
        parameter_id,
        status,
        DATA_ENTRY_MSB_CONTROLLER,
        value,
        status,
        DATA_ENTRY_LSB_CONTROLLER,
        index,
    ]
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MidiChannelKind {
    NoteOff,
    NoteOn,
    PolyphonicKeyPressure,
    ControlChange,
    ProgramChange,
    ChannelPressure,
    PitchBend,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiChannelMessage {
    pub kind: MidiChannelKind,
    /// Zero-based MIDI channel nibble (`0..=15`).
    pub channel: u8,
    pub data1: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data2: Option<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
pub enum MidiMessage {
    SysEx(Vec<u8>),
    Channel(MidiChannelMessage),
    Realtime(u8),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MidiDecodeError {
    DataWithoutRunningStatus(u8),
    InterruptedChannelMessage {
        status: u8,
        received: usize,
        expected: usize,
    },
    UnexpectedSysexEnd,
    NestedSysexStart,
    StatusInsideSysex(u8),
    SysexTooLong {
        maximum: usize,
    },
    UnsupportedSystemStatus(u8),
}

impl fmt::Display for MidiDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DataWithoutRunningStatus(byte) => {
                write!(
                    formatter,
                    "MIDI data byte 0x{byte:02X} has no running status"
                )
            }
            Self::InterruptedChannelMessage {
                status,
                received,
                expected,
            } => write!(
                formatter,
                "MIDI status 0x{status:02X} was interrupted after {received}/{expected} data bytes"
            ),
            Self::UnexpectedSysexEnd => write!(formatter, "unexpected MIDI SysEx terminator"),
            Self::NestedSysexStart => write!(formatter, "nested MIDI SysEx start"),
            Self::StatusInsideSysex(status) => {
                write!(
                    formatter,
                    "status 0x{status:02X} occurred inside MIDI SysEx"
                )
            }
            Self::SysexTooLong { maximum } => {
                write!(formatter, "MIDI SysEx exceeded the {maximum}-byte limit")
            }
            Self::UnsupportedSystemStatus(status) => {
                write!(formatter, "unsupported MIDI system status 0x{status:02X}")
            }
        }
    }
}

impl std::error::Error for MidiDecodeError {}

/// Incremental decoder for the single byte stream carried by Qu TCP MIDI.
///
/// Each input byte may yield a message or a recoverable framing error. Returning
/// errors inline preserves successfully decoded messages from the same TCP read.
#[derive(Clone, Debug)]
pub struct MidiStreamDecoder {
    running_status: Option<u8>,
    channel_data: Vec<u8>,
    sysex: Option<Vec<u8>>,
    maximum_sysex_bytes: usize,
}

impl Default for MidiStreamDecoder {
    fn default() -> Self {
        Self::with_maximum_sysex_bytes(DEFAULT_MAX_SYSEX_BYTES)
    }
}

impl MidiStreamDecoder {
    pub fn with_maximum_sysex_bytes(maximum: usize) -> Self {
        Self {
            running_status: None,
            channel_data: Vec::with_capacity(2),
            sysex: None,
            maximum_sysex_bytes: maximum.max(2),
        }
    }

    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.running_status = None;
        self.channel_data.clear();
        self.sysex = None;
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<Result<MidiMessage, MidiDecodeError>> {
        let mut output = Vec::new();
        for byte in bytes.iter().copied() {
            if is_realtime_status(byte) {
                output.push(Ok(MidiMessage::Realtime(byte)));
                continue;
            }

            if self.sysex.is_some() {
                match byte {
                    SYSEX_END => {
                        let mut message = self.sysex.take().expect("checked above");
                        message.push(byte);
                        output.push(Ok(MidiMessage::SysEx(message)));
                    }
                    SYSEX_START => {
                        output.push(Err(MidiDecodeError::NestedSysexStart));
                        self.sysex = Some(vec![SYSEX_START]);
                    }
                    0x00..=0x7F => {
                        let too_long = self
                            .sysex
                            .as_ref()
                            .is_some_and(|message| message.len() >= self.maximum_sysex_bytes - 1);
                        if too_long {
                            self.sysex = None;
                            output.push(Err(MidiDecodeError::SysexTooLong {
                                maximum: self.maximum_sysex_bytes,
                            }));
                        } else if let Some(message) = self.sysex.as_mut() {
                            message.push(byte);
                        }
                    }
                    status => {
                        self.sysex = None;
                        output.push(Err(MidiDecodeError::StatusInsideSysex(status)));
                        self.process_status(status, &mut output);
                    }
                }
                continue;
            }

            if byte >= 0x80 {
                self.process_status(byte, &mut output);
            } else {
                self.process_data(byte, &mut output);
            }
        }
        output
    }

    fn process_status(
        &mut self,
        status: u8,
        output: &mut Vec<Result<MidiMessage, MidiDecodeError>>,
    ) {
        if !self.channel_data.is_empty() {
            let previous = self.running_status.expect("data requires running status");
            output.push(Err(MidiDecodeError::InterruptedChannelMessage {
                status: previous,
                received: self.channel_data.len(),
                expected: channel_data_length(previous),
            }));
            self.channel_data.clear();
        }

        match status {
            0x80..=0xEF => self.running_status = Some(status),
            SYSEX_START => {
                self.running_status = None;
                self.sysex = Some(vec![SYSEX_START]);
            }
            SYSEX_END => {
                self.running_status = None;
                output.push(Err(MidiDecodeError::UnexpectedSysexEnd));
            }
            other => {
                self.running_status = None;
                output.push(Err(MidiDecodeError::UnsupportedSystemStatus(other)));
            }
        }
    }

    fn process_data(&mut self, byte: u8, output: &mut Vec<Result<MidiMessage, MidiDecodeError>>) {
        let Some(status) = self.running_status else {
            output.push(Err(MidiDecodeError::DataWithoutRunningStatus(byte)));
            return;
        };
        self.channel_data.push(byte);
        if self.channel_data.len() == channel_data_length(status) {
            let message = decode_channel_message(status, &self.channel_data);
            self.channel_data.clear();
            output.push(Ok(MidiMessage::Channel(message)));
        }
    }
}

fn is_realtime_status(status: u8) -> bool {
    status >= 0xF8
}

fn channel_data_length(status: u8) -> usize {
    match status & 0xF0 {
        0xC0 | 0xD0 => 1,
        _ => 2,
    }
}

fn decode_channel_message(status: u8, data: &[u8]) -> MidiChannelMessage {
    let kind = match status & 0xF0 {
        0x80 => MidiChannelKind::NoteOff,
        0x90 => MidiChannelKind::NoteOn,
        0xA0 => MidiChannelKind::PolyphonicKeyPressure,
        0xB0 => MidiChannelKind::ControlChange,
        0xC0 => MidiChannelKind::ProgramChange,
        0xD0 => MidiChannelKind::ChannelPressure,
        0xE0 => MidiChannelKind::PitchBend,
        _ => unreachable!("only channel status reaches this helper"),
    };
    MidiChannelMessage {
        kind,
        channel: status & 0x0F,
        data1: data[0],
        data2: data.get(1).copied(),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16NrpnUpdate {
    pub midi_channel: u8,
    pub channel_number: u8,
    pub parameter_id: u8,
    pub value: u8,
    pub index: u8,
}

#[derive(Clone, Copy, Debug, Default)]
struct NrpnPartial {
    channel_number: Option<u8>,
    parameter_id: Option<u8>,
    value: Option<u8>,
}

#[derive(Clone, Debug)]
pub struct Qu16NrpnAssembler {
    partials: [NrpnPartial; 16],
}

impl Default for Qu16NrpnAssembler {
    fn default() -> Self {
        Self {
            partials: array::from_fn(|_| NrpnPartial::default()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NrpnAssembleError {
    InvalidMidiChannel(u8),
    MissingDataByte {
        midi_channel: u8,
        kind: MidiChannelKind,
    },
    MissingSelector {
        midi_channel: u8,
        controller: u8,
    },
}

impl fmt::Display for NrpnAssembleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMidiChannel(channel) => {
                write!(formatter, "MIDI channel {channel} is outside 0..15")
            }
            Self::MissingDataByte { midi_channel, kind } => write!(
                formatter,
                "{kind:?} on MIDI channel {midi_channel} is missing its second data byte"
            ),
            Self::MissingSelector {
                midi_channel,
                controller,
            } => write!(
                formatter,
                "NRPN controller 0x{controller:02X} on MIDI channel {midi_channel} arrived before its selector"
            ),
        }
    }
}

impl std::error::Error for NrpnAssembleError {}

impl Qu16NrpnAssembler {
    pub fn reset(&mut self) {
        self.partials = array::from_fn(|_| NrpnPartial::default());
    }

    pub fn push(
        &mut self,
        message: &MidiMessage,
    ) -> Result<Option<Qu16NrpnUpdate>, NrpnAssembleError> {
        let MidiMessage::Channel(message) = message else {
            return Ok(None);
        };
        if message.kind != MidiChannelKind::ControlChange {
            return Ok(None);
        }
        let controller = message.data1;
        if !matches!(
            controller,
            NRPN_MSB_CONTROLLER
                | NRPN_LSB_CONTROLLER
                | DATA_ENTRY_MSB_CONTROLLER
                | DATA_ENTRY_LSB_CONTROLLER
        ) {
            return Ok(None);
        }
        if message.channel > 0x0F {
            return Err(NrpnAssembleError::InvalidMidiChannel(message.channel));
        }
        let Some(value) = message.data2 else {
            return Err(NrpnAssembleError::MissingDataByte {
                midi_channel: message.channel,
                kind: message.kind,
            });
        };

        let partial = &mut self.partials[usize::from(message.channel)];
        match controller {
            NRPN_MSB_CONTROLLER => {
                *partial = NrpnPartial {
                    channel_number: Some(value),
                    parameter_id: None,
                    value: None,
                };
                Ok(None)
            }
            NRPN_LSB_CONTROLLER => {
                if partial.channel_number.is_none() {
                    return Err(NrpnAssembleError::MissingSelector {
                        midi_channel: message.channel,
                        controller,
                    });
                }
                partial.parameter_id = Some(value);
                partial.value = None;
                Ok(None)
            }
            DATA_ENTRY_MSB_CONTROLLER => {
                if partial.channel_number.is_none() || partial.parameter_id.is_none() {
                    return Err(NrpnAssembleError::MissingSelector {
                        midi_channel: message.channel,
                        controller,
                    });
                }
                partial.value = Some(value);
                Ok(None)
            }
            DATA_ENTRY_LSB_CONTROLLER => {
                let Some(channel_number) = partial.channel_number else {
                    return Err(NrpnAssembleError::MissingSelector {
                        midi_channel: message.channel,
                        controller,
                    });
                };
                let Some(parameter_id) = partial.parameter_id else {
                    return Err(NrpnAssembleError::MissingSelector {
                        midi_channel: message.channel,
                        controller,
                    });
                };
                let Some(data_value) = partial.value else {
                    return Err(NrpnAssembleError::MissingSelector {
                        midi_channel: message.channel,
                        controller,
                    });
                };
                // MIDI NRPN controllers commonly keep the selected parameter
                // active while a motor fader is moving and then emit only
                // repeated Data Entry MSB/LSB pairs.  Preserve both selector
                // bytes after one complete value; only the value half is
                // consumed.  A later NRPN MSB still starts a fresh selector,
                // and the runtime explicitly resets this assembler after a
                // framing error or reconnect.
                partial.value = None;
                Ok(Some(Qu16NrpnUpdate {
                    midi_channel: message.channel,
                    channel_number,
                    parameter_id,
                    value: data_value,
                    index: value,
                }))
            }
            _ => unreachable!("controller was filtered above"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Qu16ObservedControl {
    Fader,
    SendLevel,
    Mute,
    Pafl,
    Pan,
    Assign,
    PreFade,
    Processing,
    MuteGroup,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Qu16ObservedValue {
    SevenBit(u8),
    Boolean(bool),
}

impl Qu16ObservedValue {
    pub fn as_raw_value(&self) -> u8 {
        match self {
            Self::SevenBit(value) => *value,
            Self::Boolean(value) => u8::from(*value),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Qu16ControlObservation {
    /// Stable cache key, independent of MIDI channel and connection session.
    pub key: String,
    pub target_id: String,
    pub control: Qu16ObservedControl,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mix: Option<String>,
    pub value: Qu16ObservedValue,
}

pub fn normalize_nrpn_observation(update: &Qu16NrpnUpdate) -> Option<Qu16ControlObservation> {
    let target = target_from_channel_number(update.channel_number)?;
    match (update.parameter_id, update.index) {
        (FADER_PARAMETER_ID, FIXED_INDEX) => Some(Qu16ControlObservation {
            key: format!("fader:{}", target.ui_id),
            target_id: target.ui_id.to_string(),
            control: Qu16ObservedControl::Fader,
            mix: None,
            value: Qu16ObservedValue::SevenBit(update.value),
        }),
        (SEND_LEVEL_PARAMETER_ID, index) if target.role == Qu16TargetRole::Source => {
            let bus = send_bus_from_index(index)?;
            Some(Qu16ControlObservation {
                key: format!("send:{}:{}", target.ui_id, bus.label),
                target_id: target.ui_id.to_string(),
                control: Qu16ObservedControl::SendLevel,
                mix: Some(bus.label.to_string()),
                value: Qu16ObservedValue::SevenBit(update.value),
            })
        }
        (PAFL_PARAMETER_ID, FIXED_INDEX) if update.value <= 1 => Some(Qu16ControlObservation {
            key: format!("pafl:{}", target.ui_id),
            target_id: target.ui_id.to_string(),
            control: Qu16ObservedControl::Pafl,
            mix: None,
            value: Qu16ObservedValue::Boolean(update.value == 1),
        }),
        (PAN_PARAMETER_ID, index) if update.value <= 0x4A => {
            let mix = pan_bus_from_index(index)?;
            Some(Qu16ControlObservation {
                key: format!("pan:{}:{mix}", target.ui_id),
                target_id: target.ui_id.to_string(),
                control: Qu16ObservedControl::Pan,
                mix: Some(mix.to_string()),
                value: Qu16ObservedValue::SevenBit(update.value),
            })
        }
        (parameter_id, index) if update.value <= 1 => {
            if let Some(mix) = assign_bus_from_wire(parameter_id, index) {
                if target.role != Qu16TargetRole::Source {
                    return None;
                }
                return Some(Qu16ControlObservation {
                    key: format!("assign:{}:{mix}", target.ui_id),
                    target_id: target.ui_id.to_string(),
                    control: Qu16ObservedControl::Assign,
                    mix: Some(mix.to_string()),
                    value: Qu16ObservedValue::Boolean(update.value == 1),
                });
            }
            if parameter_id == MIX_PRE_POST_PARAMETER_ID {
                let bus = send_bus_from_index(index)?;
                if target.role != Qu16TargetRole::Source {
                    return None;
                }
                return Some(Qu16ControlObservation {
                    key: format!("pre:{}:{}", target.ui_id, bus.label),
                    target_id: target.ui_id.to_string(),
                    control: Qu16ObservedControl::PreFade,
                    mix: Some(bus.label.to_string()),
                    value: Qu16ObservedValue::Boolean(update.value == 1),
                });
            }
            let spec = processing_parameter_from_wire(parameter_id, index)?;
            Some(Qu16ControlObservation {
                key: format!("process:{}:{}", target.ui_id, spec.key),
                target_id: target.ui_id.to_string(),
                control: Qu16ObservedControl::Processing,
                mix: None,
                value: match spec.value_kind {
                    Qu16ParameterValueKind::Binary => Qu16ObservedValue::Boolean(update.value == 1),
                    Qu16ParameterValueKind::SevenBit => Qu16ObservedValue::SevenBit(update.value),
                },
            })
        }
        (parameter_id, index) => {
            let spec = processing_parameter_from_wire(parameter_id, index)?;
            if spec.value_kind != Qu16ParameterValueKind::SevenBit {
                return None;
            }
            Some(Qu16ControlObservation {
                key: format!("process:{}:{}", target.ui_id, spec.key),
                target_id: target.ui_id.to_string(),
                control: Qu16ObservedControl::Processing,
                mix: None,
                value: Qu16ObservedValue::SevenBit(update.value),
            })
        }
    }
}

/// Stateful observer for Qu core-control messages on the MIDI channel learned
/// from Get System State. Filtering by that channel prevents N+1 DAW strip
/// messages from being mistaken for audio-core control feedback.
#[derive(Clone, Debug)]
pub struct Qu16ControlObserver {
    midi_channel: u8,
    nrpn: Qu16NrpnAssembler,
}

impl Qu16ControlObserver {
    pub fn new(midi_channel: u8) -> Result<Self, Qu16ControlError> {
        validate_midi_channel(midi_channel)?;
        Ok(Self {
            midi_channel,
            nrpn: Qu16NrpnAssembler::default(),
        })
    }

    pub fn reset(&mut self) {
        self.nrpn.reset();
    }

    pub fn push(
        &mut self,
        message: &MidiMessage,
    ) -> Result<Option<Qu16ControlObservation>, NrpnAssembleError> {
        let MidiMessage::Channel(channel_message) = message else {
            return Ok(None);
        };
        if channel_message.channel != self.midi_channel {
            return Ok(None);
        }

        if channel_message.kind == MidiChannelKind::NoteOn {
            let Some(velocity) = channel_message.data2 else {
                return Err(NrpnAssembleError::MissingDataByte {
                    midi_channel: channel_message.channel,
                    kind: channel_message.kind,
                });
            };
            let muted = match velocity {
                0x7F => true,
                0x3F => false,
                // 0x00 is the documented terminating release event. Other
                // velocities are not Qu mute-state messages either.
                _ => return Ok(None),
            };
            // Mute Groups have dedicated CH bytes 0x50..0x53 but are not
            // writable surface targets in this application. Observe their
            // master states separately so SoftKey status can be truthful
            // without making arbitrary group controls addressable for writes.
            if (0x50..=0x53).contains(&channel_message.data1) {
                let group = channel_message.data1 - 0x50 + 1;
                return Ok(Some(Qu16ControlObservation {
                    key: format!("mute-group:{group}"),
                    target_id: format!("mute-group-{group}"),
                    control: Qu16ObservedControl::MuteGroup,
                    mix: None,
                    value: Qu16ObservedValue::Boolean(muted),
                }));
            }
            let Some(target) = target_from_channel_number(channel_message.data1) else {
                return Ok(None);
            };
            return Ok(Some(Qu16ControlObservation {
                key: format!("mute:{}", target.ui_id),
                target_id: target.ui_id.to_string(),
                control: Qu16ObservedControl::Mute,
                mix: None,
                value: Qu16ObservedValue::Boolean(muted),
            }));
        }

        let update = self.nrpn.push(message)?;
        Ok(update.as_ref().and_then(normalize_nrpn_observation))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fader(target_id: &str, value: u8) -> Qu16ControlCommand {
        Qu16ControlCommand::Fader {
            target_id: target_id.to_string(),
            value,
        }
    }

    fn decode_ok(decoder: &mut MidiStreamDecoder, bytes: &[u8]) -> Vec<MidiMessage> {
        decoder
            .push(bytes)
            .into_iter()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn maps_page_3_and_13_qu16_channel_numbers_to_ui_ids() {
        assert_eq!(target_from_ui_id("fx-1-send").unwrap().channel_number, 0x00);
        assert_eq!(target_from_ui_id("fx-2-send").unwrap().channel_number, 0x01);
        assert_eq!(target_from_ui_id("fx-1-ret").unwrap().channel_number, 0x08);
        assert_eq!(target_from_ui_id("fx-2-ret").unwrap().channel_number, 0x09);
        assert_eq!(target_from_ui_id("fx-4-ret").unwrap().channel_number, 0x0B);
        assert_eq!(target_from_ui_id("ch-1").unwrap().channel_number, 0x20);
        assert_eq!(target_from_ui_id("ch-8").unwrap().channel_number, 0x27);
        assert_eq!(target_from_ui_id("ch-9").unwrap().channel_number, 0x28);
        assert_eq!(target_from_ui_id("ch-16").unwrap().channel_number, 0x2F);
        assert_eq!(target_from_ui_id("st-1").unwrap().channel_number, 0x40);
        assert_eq!(target_from_ui_id("st-3").unwrap().channel_number, 0x42);
        assert_eq!(
            target_from_ui_id("mix-1-master").unwrap().channel_number,
            0x60
        );
        assert_eq!(
            target_from_ui_id("mix-9-10-master").unwrap().channel_number,
            0x66
        );
        assert_eq!(target_from_ui_id("lr-master").unwrap().channel_number, 0x67);
        assert!(target_from_ui_id("ch-17").is_none());
        assert!(target_from_ui_id("FX 1").is_none());
    }

    #[test]
    fn encodes_page_5_fader_with_page_13_zero_db_value() {
        assert_eq!(
            fader("ch-1", 0x62).encode(3).unwrap(),
            vec![0xB3, 0x63, 0x20, 0xB3, 0x62, 0x17, 0xB3, 0x06, 0x62, 0xB3, 0x26, 0x07,]
        );
    }

    #[test]
    fn encodes_page_6_send_and_pafl_indexes() {
        let mix_send = Qu16ControlCommand::SendLevel {
            target_id: "st-1".into(),
            mix: "Mix 5-6".into(),
            value: 0x0A,
        };
        assert_eq!(
            mix_send.encode(0).unwrap(),
            vec![0xB0, 0x63, 0x40, 0xB0, 0x62, 0x20, 0xB0, 0x06, 0x0A, 0xB0, 0x26, 0x04,]
        );

        let fx_send = Qu16ControlCommand::SendLevel {
            target_id: "ch-16".into(),
            mix: "FX 2".into(),
            value: 0x7F,
        };
        assert_eq!(fx_send.encode(0).unwrap()[11], 0x11);

        let pafl = Qu16ControlCommand::Pafl {
            target_id: "mix-1-master".into(),
            enabled: true,
        };
        assert_eq!(
            pafl.encode(5).unwrap(),
            vec![0xB5, 0x63, 0x60, 0xB5, 0x62, 0x51, 0xB5, 0x06, 0x01, 0xB5, 0x26, 0x07,]
        );
    }

    #[test]
    fn encodes_pan_routing_and_processing_from_semantic_commands() {
        let cases = [
            (
                Qu16ControlCommand::Pan {
                    target_id: "ch-1".into(),
                    mix: "LR".into(),
                    value: 0x25,
                },
                PAN_PARAMETER_ID,
                0x25,
                FIXED_INDEX,
            ),
            (
                Qu16ControlCommand::Assign {
                    target_id: "ch-1".into(),
                    mix: "Mix 1".into(),
                    assigned: true,
                },
                MIX_ASSIGN_PARAMETER_ID,
                1,
                0,
            ),
            (
                Qu16ControlCommand::PreFade {
                    target_id: "ch-1".into(),
                    mix: "Mix 1".into(),
                    pre: true,
                },
                MIX_PRE_POST_PARAMETER_ID,
                1,
                0,
            ),
            (
                Qu16ControlCommand::Processing {
                    target_id: "ch-1".into(),
                    parameter: "gate-in".into(),
                    value: 1,
                },
                0x46,
                1,
                0,
            ),
            (
                Qu16ControlCommand::Processing {
                    target_id: "ch-1".into(),
                    parameter: "peq-lm-frequency".into(),
                    value: 64,
                },
                0x06,
                64,
                FIXED_INDEX,
            ),
        ];

        for (command, parameter_id, value, index) in cases {
            let bytes = command.encode(0).unwrap();
            assert_eq!(bytes[5], parameter_id);
            assert_eq!(bytes[8], value);
            assert_eq!(bytes[11], index);
            assert_ne!(bytes[5], 0x5F);
        }
    }

    #[test]
    fn observer_normalizes_extended_binary_and_zero_seven_bit_values() {
        let binary = normalize_nrpn_observation(&Qu16NrpnUpdate {
            midi_channel: 0,
            channel_number: 0x20,
            parameter_id: 0x46,
            value: 1,
            index: 0,
        })
        .unwrap();
        assert_eq!(binary.key, "process:ch-1:gate-in");
        assert_eq!(binary.value, Qu16ObservedValue::Boolean(true));

        let zero_numeric = normalize_nrpn_observation(&Qu16NrpnUpdate {
            midi_channel: 0,
            channel_number: 0x20,
            parameter_id: 0x06,
            value: 0,
            index: FIXED_INDEX,
        })
        .unwrap();
        assert_eq!(zero_numeric.key, "process:ch-1:peq-lm-frequency");
        assert_eq!(zero_numeric.value, Qu16ObservedValue::SevenBit(0));

        let assign = normalize_nrpn_observation(&Qu16NrpnUpdate {
            midi_channel: 0,
            channel_number: 0x20,
            parameter_id: MIX_ASSIGN_PARAMETER_ID,
            value: 1,
            index: 0,
        })
        .unwrap();
        assert_eq!(assign.key, "assign:ch-1:Mix 1");
        assert_eq!(assign.value, Qu16ObservedValue::Boolean(true));
    }

    #[test]
    fn encodes_page_5_mute_note_on_and_terminating_zero_velocity() {
        let on = Qu16ControlCommand::Mute {
            target_id: "ch-1".into(),
            muted: true,
        };
        assert_eq!(
            on.encode(2).unwrap(),
            vec![0x92, 0x20, 0x7F, 0x92, 0x20, 0x00]
        );

        let off = Qu16ControlCommand::Mute {
            target_id: "lr-master".into(),
            muted: false,
        };
        assert_eq!(
            off.encode(2).unwrap(),
            vec![0x92, 0x67, 0x3F, 0x92, 0x67, 0x00]
        );
    }

    #[test]
    fn semantic_commands_reject_raw_or_unsafe_inputs() {
        assert_eq!(
            fader("ch-1", 0x80).encode(0),
            Err(Qu16ControlError::NonSevenBitValue(0x80))
        );
        assert_eq!(
            fader("ch-1", 1).encode(16),
            Err(Qu16ControlError::InvalidMidiChannel(16))
        );
        assert!(matches!(
            fader("ch-17", 1).encode(0),
            Err(Qu16ControlError::UnknownTarget(_))
        ));
        assert!(matches!(
            Qu16ControlCommand::SendLevel {
                target_id: "mix-1-master".into(),
                mix: "Mix 2".into(),
                value: 1,
            }
            .encode(0),
            Err(Qu16ControlError::SendRequiresSource(_))
        ));
        assert!(matches!(
            Qu16ControlCommand::SendLevel {
                target_id: "ch-1".into(),
                mix: "LR".into(),
                value: 1,
            }
            .encode(0),
            Err(Qu16ControlError::UnknownSendBus(_))
        ));

        let raw_id = r#"{"kind":"fader","targetId":"ch-1","value":1,"parameterId":95}"#;
        assert!(serde_json::from_str::<Qu16ControlCommand>(raw_id).is_err());
        let shutdown = r#"{"kind":"remote-shutdown","targetId":"ch-1"}"#;
        assert!(serde_json::from_str::<Qu16ControlCommand>(shutdown).is_err());
    }

    #[test]
    fn semantic_command_is_serde_round_trippable() {
        let command = Qu16ControlCommand::SendLevel {
            target_id: "ch-2".into(),
            mix: "Mix 7-8".into(),
            value: 93,
        };
        let json = serde_json::to_string(&command).unwrap();
        assert!(json.contains(r#""kind":"send-level""#));
        assert_eq!(
            serde_json::from_str::<Qu16ControlCommand>(&json).unwrap(),
            command
        );
    }

    #[test]
    fn frontend_parameter_write_contract_is_canonical_and_raw_safe() {
        let cases = [
            ("fader:ch-1", 98, "fader:ch-1"),
            ("send:st-2:Mix 7-8", 64, "send:st-2:Mix 7-8"),
            ("mute:fx-1-ret", 1, "mute:fx-1-ret"),
            ("pafl:lr-master", 0, "pafl:lr-master"),
        ];
        for (key, value, expected_key) in cases {
            let command = command_from_parameter_write(&Qu16ParameterWrite {
                key: key.into(),
                value,
            })
            .unwrap();
            let expected = command.expected_parameter().unwrap();
            assert_eq!(expected.key, expected_key);
            assert_eq!(expected.value, value);
        }

        for (key, value) in [
            ("send-level:ch-1:mix-1-master", 1),
            ("send:ch-1:mix-1-master", 1),
            ("send:ch-1:LR", 1),
            ("fader:32", 1),
            ("fader:ch-1:95", 1),
            ("mute:ch-1", 2),
            ("pafl:ch-1", 127),
            ("fader:ch-1", 128),
        ] {
            assert!(command_from_parameter_write(&Qu16ParameterWrite {
                key: key.into(),
                value,
            })
            .is_err());
        }

        let raw = r#"{"key":"fader:ch-1","value":1,"parameterId":95}"#;
        assert!(serde_json::from_str::<Qu16ParameterWrite>(raw).is_err());
    }

    #[test]
    fn decoder_preserves_page_10_get_state_sysex_across_fragments_and_fe() {
        let mut decoder = MidiStreamDecoder::default();
        let first = decode_ok(&mut decoder, &[0xF0, 0x00, 0x00, 0x1A, 0x50, 0xFE, 0x11]);
        assert_eq!(first, vec![MidiMessage::Realtime(0xFE)]);
        let second = decode_ok(&mut decoder, &[0x01, 0x00, 0x7F, 0x10, 0x01, 0xF7]);
        assert_eq!(
            second,
            vec![MidiMessage::SysEx(vec![
                0xF0, 0x00, 0x00, 0x1A, 0x50, 0x11, 0x01, 0x00, 0x7F, 0x10, 0x01, 0xF7,
            ])]
        );
    }

    #[test]
    fn decoder_handles_running_status_fragmentation_and_interleaved_fe() {
        let mut decoder = MidiStreamDecoder::default();
        assert!(decode_ok(&mut decoder, &[0xB3, 0x63]).is_empty());
        let messages = decode_ok(
            &mut decoder,
            &[0x20, 0x62, 0x17, 0xFE, 0x06, 0x62, 0x26, 0x07],
        );
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[2], MidiMessage::Realtime(0xFE));

        let mut assembler = Qu16NrpnAssembler::default();
        let update = messages
            .iter()
            .filter_map(|message| assembler.push(message).transpose())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            update,
            vec![Qu16NrpnUpdate {
                midi_channel: 3,
                channel_number: 0x20,
                parameter_id: 0x17,
                value: 0x62,
                index: 0x07,
            }]
        );
    }

    #[test]
    fn decoder_reports_errors_and_recovers_at_fresh_status() {
        let mut decoder = MidiStreamDecoder::default();
        assert_eq!(
            decoder.push(&[0x01]),
            vec![Err(MidiDecodeError::DataWithoutRunningStatus(0x01))]
        );
        let interrupted = decoder.push(&[0xB0, 0x63, 0x90, 0x20, 0x7F]);
        assert!(matches!(
            interrupted.first(),
            Some(Err(MidiDecodeError::InterruptedChannelMessage {
                status: 0xB0,
                received: 1,
                expected: 2
            }))
        ));
        assert!(matches!(
            interrupted.last(),
            Some(Ok(MidiMessage::Channel(MidiChannelMessage {
                kind: MidiChannelKind::NoteOn,
                channel: 0,
                data1: 0x20,
                data2: Some(0x7F)
            })))
        ));
        assert_eq!(
            decoder.push(&[0xF7]),
            vec![Err(MidiDecodeError::UnexpectedSysexEnd)]
        );
        let malformed_sysex = decoder.push(&[0xF0, 0x01, 0x90, 0x20, 0x7F]);
        assert!(matches!(
            malformed_sysex.first(),
            Some(Err(MidiDecodeError::StatusInsideSysex(0x90)))
        ));
        assert!(matches!(
            malformed_sysex.last(),
            Some(Ok(MidiMessage::Channel(_)))
        ));
    }

    #[test]
    fn nrpn_assembler_rejects_incomplete_order_and_keeps_channels_independent() {
        let mut assembler = Qu16NrpnAssembler::default();
        let invalid_channel = MidiMessage::Channel(MidiChannelMessage {
            kind: MidiChannelKind::ControlChange,
            channel: 16,
            data1: NRPN_MSB_CONTROLLER,
            data2: Some(0x20),
        });
        assert_eq!(
            assembler.push(&invalid_channel),
            Err(NrpnAssembleError::InvalidMidiChannel(16))
        );
        let missing_data = MidiMessage::Channel(MidiChannelMessage {
            kind: MidiChannelKind::ControlChange,
            channel: 0,
            data1: NRPN_MSB_CONTROLLER,
            data2: None,
        });
        assert_eq!(
            assembler.push(&missing_data),
            Err(NrpnAssembleError::MissingDataByte {
                midi_channel: 0,
                kind: MidiChannelKind::ControlChange,
            })
        );
        let data_entry = MidiMessage::Channel(MidiChannelMessage {
            kind: MidiChannelKind::ControlChange,
            channel: 0,
            data1: DATA_ENTRY_MSB_CONTROLLER,
            data2: Some(1),
        });
        assert_eq!(
            assembler.push(&data_entry),
            Err(NrpnAssembleError::MissingSelector {
                midi_channel: 0,
                controller: DATA_ENTRY_MSB_CONTROLLER,
            })
        );

        let mut decoder = MidiStreamDecoder::default();
        let interleaved = decode_ok(
            &mut decoder,
            &[
                0xB0, 0x63, 0x20, 0xB1, 0x63, 0x21, 0xB0, 0x62, 0x17, 0xB1, 0x62, 0x51, 0xB0, 0x06,
                0x62, 0xB1, 0x06, 0x01, 0xB0, 0x26, 0x07, 0xB1, 0x26, 0x07,
            ],
        );
        let updates = interleaved
            .iter()
            .filter_map(|message| assembler.push(message).transpose())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].midi_channel, 0);
        assert_eq!(updates[1].midi_channel, 1);
        assert_eq!(updates[1].parameter_id, PAFL_PARAMETER_ID);
    }

    #[test]
    fn nrpn_assembler_keeps_fader_selector_for_continuous_ch8_ch9_values() {
        let mut decoder = MidiStreamDecoder::default();
        let messages = decode_ok(
            &mut decoder,
            &[
                // CH8 fader selector + first value, followed by a second value
                // with the selector intentionally omitted (normal NRPN running
                // behaviour while a physical motor fader is moving).
                0xB0, 0x63, 0x27, 0x62, 0x17, 0x06, 0x22, 0x26, 0x07, 0x06, 0x55, 0x26, 0x07,
                // A fresh selector must still switch cleanly to CH9.
                0x63, 0x28, 0x62, 0x17, 0x06, 0x66, 0x26, 0x07,
            ],
        );
        let mut observer = Qu16ControlObserver::new(0).unwrap();
        let observations = messages
            .iter()
            .filter_map(|message| observer.push(message).transpose())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(observations.len(), 3);
        assert_eq!(observations[0].key, "fader:ch-8");
        assert_eq!(observations[0].value, Qu16ObservedValue::SevenBit(0x22));
        assert_eq!(observations[1].key, "fader:ch-8");
        assert_eq!(observations[1].value, Qu16ObservedValue::SevenBit(0x55));
        assert_eq!(observations[2].key, "fader:ch-9");
        assert_eq!(observations[2].value, Qu16ObservedValue::SevenBit(0x66));
    }

    #[test]
    fn observer_normalizes_fader_send_pafl_and_mute_to_stable_keys() {
        let bytes = [
            fader("ch-1", 0x62).encode(3).unwrap(),
            Qu16ControlCommand::SendLevel {
                target_id: "ch-1".into(),
                mix: "Mix 5-6".into(),
                value: 0x44,
            }
            .encode(3)
            .unwrap(),
            Qu16ControlCommand::Pafl {
                target_id: "ch-1".into(),
                enabled: true,
            }
            .encode(3)
            .unwrap(),
            Qu16ControlCommand::Mute {
                target_id: "ch-1".into(),
                muted: true,
            }
            .encode(3)
            .unwrap(),
        ]
        .concat();

        let messages = decode_ok(&mut MidiStreamDecoder::default(), &bytes);
        let mut observer = Qu16ControlObserver::new(3).unwrap();
        let observations: Vec<_> = messages
            .iter()
            .filter_map(|message| observer.push(message).transpose())
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            observations
                .iter()
                .map(|observation| observation.key.as_str())
                .collect::<Vec<_>>(),
            vec!["fader:ch-1", "send:ch-1:Mix 5-6", "pafl:ch-1", "mute:ch-1",]
        );
        assert_eq!(observations[0].value, Qu16ObservedValue::SevenBit(0x62));
        assert_eq!(observations[2].value, Qu16ObservedValue::Boolean(true));
        assert_eq!(observations[3].value, Qu16ObservedValue::Boolean(true));
    }

    #[test]
    fn observer_reads_mute_group_master_states_without_exposing_write_targets() {
        let mut observer = Qu16ControlObserver::new(3).unwrap();
        let messages = decode_ok(
            &mut MidiStreamDecoder::default(),
            &[
                0x93, 0x50, 0x7F, // Mute Group 1 on.
                0x93, 0x50, 0x00, // Documented terminating release.
                0x93, 0x53, 0x3F, // Mute Group 4 off.
            ],
        );
        let observations: Vec<_> = messages
            .iter()
            .filter_map(|message| observer.push(message).transpose())
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].key, "mute-group:1");
        assert_eq!(observations[0].target_id, "mute-group-1");
        assert_eq!(observations[0].control, Qu16ObservedControl::MuteGroup);
        assert_eq!(observations[0].value, Qu16ObservedValue::Boolean(true));
        assert_eq!(observations[1].key, "mute-group:4");
        assert_eq!(observations[1].value, Qu16ObservedValue::Boolean(false));
    }

    #[test]
    fn observer_ignores_daw_channel_note_terminators_and_remote_shutdown() {
        let mut observer = Qu16ControlObserver::new(3).unwrap();
        let mut decoder = MidiStreamDecoder::default();
        let messages = decode_ok(
            &mut decoder,
            &[
                0x94, 0x20, 0x7F, 0x93, 0x20, 0x00, 0x93, 0x20, 0x40, 0x93, 0x20, 0x3F,
            ],
        );
        let observations: Vec<_> = messages
            .iter()
            .filter_map(|message| observer.push(message).transpose())
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].key, "mute:ch-1");
        assert_eq!(observations[0].value, Qu16ObservedValue::Boolean(false));

        let shutdown = Qu16NrpnUpdate {
            midi_channel: 0,
            channel_number: 0,
            parameter_id: 0x5F,
            value: 0,
            index: 0,
        };
        assert!(normalize_nrpn_observation(&shutdown).is_none());
    }

    #[test]
    fn sysex_limit_and_nested_start_are_reported() {
        let mut decoder = MidiStreamDecoder::with_maximum_sysex_bytes(4);
        assert_eq!(
            decoder.push(&[0xF0, 0x01, 0x02, 0x03]),
            vec![Err(MidiDecodeError::SysexTooLong { maximum: 4 })]
        );
        decoder.reset();
        assert_eq!(
            decoder.push(&[0xF0, 0x01, 0xF0]),
            vec![Err(MidiDecodeError::NestedSysexStart)]
        );
    }
}
