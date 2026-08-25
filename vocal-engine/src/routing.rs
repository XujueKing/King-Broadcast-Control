use crate::{preset::VocalLaneId, EngineError, SAMPLE_RATE};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const ROUTING_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AsioDirection {
    Input,
    Output,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsioChannelDescriptor {
    pub driver_index: usize,
    pub name: String,
    pub direction: AsioDirection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsioChannelInventory {
    pub driver_name: String,
    pub sample_rate: u32,
    pub physical_hardware: bool,
    pub input_channels: Vec<AsioChannelDescriptor>,
    pub output_channels: Vec<AsioChannelDescriptor>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteEvidence {
    VirtualSignalTrace,
    OnsiteSignalTrace,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalLaneRoute {
    pub lane: VocalLaneId,
    pub qu_input_channel: u8,
    pub input_driver_index: usize,
    pub input_channel_name: String,
    pub return_driver_index: usize,
    pub return_channel_name: String,
    pub evidence: RouteEvidence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalRoutingMap {
    pub schema_version: u32,
    pub driver_name: String,
    pub sample_rate: u32,
    pub physical_hardware: bool,
    pub qu16_mapping_verified: bool,
    pub lanes: Vec<VocalLaneRoute>,
    pub created_by: String,
    pub blockers: Vec<String>,
}

impl VocalRoutingMap {
    pub fn validate_against(&self, inventory: &AsioChannelInventory) -> Result<(), EngineError> {
        if self.schema_version != ROUTING_SCHEMA_VERSION {
            return Err(EngineError("unsupported routing schema version".into()));
        }
        if self.driver_name != inventory.driver_name {
            return Err(EngineError(
                "routing map driver does not match inventory".into(),
            ));
        }
        if self.sample_rate != SAMPLE_RATE || inventory.sample_rate != SAMPLE_RATE {
            return Err(EngineError("vocal routing requires 48000 Hz".into()));
        }
        if self.lanes.len() != 3 {
            return Err(EngineError(
                "routing map must contain exactly three vocal lanes".into(),
            ));
        }

        let inputs = channel_lookup(&inventory.input_channels, AsioDirection::Input)?;
        let outputs = channel_lookup(&inventory.output_channels, AsioDirection::Output)?;
        let mut lanes = HashSet::new();
        let mut qu_channels = HashSet::new();
        let mut input_indices = HashSet::new();
        let mut return_indices = HashSet::new();

        for route in &self.lanes {
            if !lanes.insert(route.lane)
                || !qu_channels.insert(route.qu_input_channel)
                || !input_indices.insert(route.input_driver_index)
                || !return_indices.insert(route.return_driver_index)
            {
                return Err(EngineError(
                    "routing map contains a duplicate lane or channel".into(),
                ));
            }
            if inputs.get(&route.input_driver_index) != Some(&route.input_channel_name.as_str()) {
                return Err(EngineError(format!(
                    "input channel {} name/index mismatch",
                    route.input_driver_index
                )));
            }
            if outputs.get(&route.return_driver_index) != Some(&route.return_channel_name.as_str())
            {
                return Err(EngineError(format!(
                    "return channel {} name/index mismatch",
                    route.return_driver_index
                )));
            }
        }

        let expected_lanes = [VocalLaneId::Mic1, VocalLaneId::Mic2, VocalLaneId::Mic3];
        let expected_qu_channels = [1_u8, 2, 3];
        if expected_lanes.iter().any(|lane| !lanes.contains(lane))
            || expected_qu_channels
                .iter()
                .any(|channel| !qu_channels.contains(channel))
        {
            return Err(EngineError(
                "routing map must cover Mic1-3 and Qu inputs 1-3".into(),
            ));
        }
        Ok(())
    }

    pub fn hardware_ready(&self, inventory: &AsioChannelInventory) -> bool {
        self.validate_against(inventory).is_ok()
            && self.physical_hardware
            && inventory.physical_hardware
            && self.qu16_mapping_verified
            && self
                .lanes
                .iter()
                .all(|route| route.evidence == RouteEvidence::OnsiteSignalTrace)
    }
}

fn channel_lookup(
    channels: &[AsioChannelDescriptor],
    expected_direction: AsioDirection,
) -> Result<HashMap<usize, &str>, EngineError> {
    let mut lookup = HashMap::new();
    for channel in channels {
        if channel.direction != expected_direction {
            return Err(EngineError(
                "channel inventory contains a wrong direction".into(),
            ));
        }
        if lookup
            .insert(channel.driver_index, channel.name.as_str())
            .is_some()
        {
            return Err(EngineError(
                "channel inventory contains a duplicate index".into(),
            ));
        }
    }
    Ok(lookup)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingProbeReport {
    pub lane: VocalLaneId,
    pub selected_input_index: usize,
    pub selected_return_index: usize,
    pub selected_peak_dbfs: f32,
    pub strongest_other_peak_dbfs: f32,
    pub isolation_db: f32,
    pub unique: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalRoutingDiscoveryReport {
    pub schema_version: u32,
    pub mode: &'static str,
    pub inventory: AsioChannelInventory,
    pub routing_map: VocalRoutingMap,
    pub probes: Vec<RoutingProbeReport>,
    pub structural_validation_passed: bool,
    pub hardware_ready: bool,
    pub ambiguity_count: usize,
    pub writes_performed: bool,
    pub audio_output_started: bool,
}

pub fn run_virtual_routing_discovery() -> Result<VocalRoutingDiscoveryReport, EngineError> {
    let inventory = AsioChannelInventory {
        driver_name: "KING Virtual Qu-16 ASIO".into(),
        sample_rate: SAMPLE_RATE,
        physical_hardware: false,
        input_channels: vec![
            channel(2, "Virtual Mic Send A", AsioDirection::Input),
            channel(5, "Virtual Mic Send B", AsioDirection::Input),
            channel(9, "Virtual Mic Send C", AsioDirection::Input),
        ],
        output_channels: vec![
            channel(1, "Virtual Vocal Return A", AsioDirection::Output),
            channel(4, "Virtual Vocal Return B", AsioDirection::Output),
            channel(8, "Virtual Vocal Return C", AsioDirection::Output),
        ],
    };
    let specs = [
        (VocalLaneId::Mic1, 1, 2, 1, "A"),
        (VocalLaneId::Mic2, 2, 5, 4, "B"),
        (VocalLaneId::Mic3, 3, 9, 8, "C"),
    ];
    let lanes = specs
        .iter()
        .map(
            |(lane, qu_channel, input_index, return_index, suffix)| VocalLaneRoute {
                lane: *lane,
                qu_input_channel: *qu_channel,
                input_driver_index: *input_index,
                input_channel_name: format!("Virtual Mic Send {suffix}"),
                return_driver_index: *return_index,
                return_channel_name: format!("Virtual Vocal Return {suffix}"),
                evidence: RouteEvidence::VirtualSignalTrace,
            },
        )
        .collect::<Vec<_>>();
    let routing_map = VocalRoutingMap {
        schema_version: ROUTING_SCHEMA_VERSION,
        driver_name: inventory.driver_name.clone(),
        sample_rate: SAMPLE_RATE,
        physical_hardware: false,
        qu16_mapping_verified: false,
        lanes,
        created_by: "offline_virtual_signal_trace".into(),
        blockers: vec![
            "Qu-16 USB/ASIO hardware is not connected".into(),
            "Qu-16 input and USB return patches require onsite signal trace".into(),
            "DP440 and downstream PA routing remain outside this discovery".into(),
        ],
    };
    routing_map.validate_against(&inventory)?;

    let probes = specs
        .iter()
        .map(
            |(lane, _, input_index, return_index, _)| RoutingProbeReport {
                lane: *lane,
                selected_input_index: *input_index,
                selected_return_index: *return_index,
                selected_peak_dbfs: -12.0,
                strongest_other_peak_dbfs: -84.0,
                isolation_db: 72.0,
                unique: true,
            },
        )
        .collect::<Vec<_>>();
    let ambiguity_count = probes.iter().filter(|probe| !probe.unique).count();
    let hardware_ready = routing_map.hardware_ready(&inventory);
    Ok(VocalRoutingDiscoveryReport {
        schema_version: ROUTING_SCHEMA_VERSION,
        mode: "virtual_signal_trace",
        inventory,
        routing_map,
        probes,
        structural_validation_passed: true,
        hardware_ready,
        ambiguity_count,
        writes_performed: false,
        audio_output_started: false,
    })
}

fn channel(index: usize, name: &str, direction: AsioDirection) -> AsioChannelDescriptor {
    AsioChannelDescriptor {
        driver_index: index,
        name: name.into(),
        direction,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_discovery_is_structurally_valid_but_never_hardware_ready() {
        let report = run_virtual_routing_discovery().unwrap();
        assert!(report.structural_validation_passed);
        assert!(!report.hardware_ready);
        assert!(!report.inventory.physical_hardware);
        assert_eq!(report.ambiguity_count, 0);
        assert!(!report.writes_performed);
        assert!(!report.audio_output_started);
    }

    #[test]
    fn mapping_does_not_assume_contiguous_driver_indices() {
        let report = run_virtual_routing_discovery().unwrap();
        let inputs = report
            .routing_map
            .lanes
            .iter()
            .map(|route| route.input_driver_index)
            .collect::<Vec<_>>();
        assert_eq!(inputs, vec![2, 5, 9]);
    }

    #[test]
    fn duplicate_input_channel_is_rejected() {
        let report = run_virtual_routing_discovery().unwrap();
        let mut mapping = report.routing_map;
        mapping.lanes[1].input_driver_index = mapping.lanes[0].input_driver_index;
        mapping.lanes[1].input_channel_name = mapping.lanes[0].input_channel_name.clone();
        assert!(mapping.validate_against(&report.inventory).is_err());
    }

    #[test]
    fn wrong_direction_inventory_is_rejected() {
        let report = run_virtual_routing_discovery().unwrap();
        let mut inventory = report.inventory;
        inventory.input_channels[0].direction = AsioDirection::Output;
        assert!(report.routing_map.validate_against(&inventory).is_err());
    }

    #[test]
    fn name_and_index_mismatch_is_rejected() {
        let report = run_virtual_routing_discovery().unwrap();
        let mut mapping = report.routing_map;
        mapping.lanes[0].input_channel_name = "guessed CH1".into();
        assert!(mapping.validate_against(&report.inventory).is_err());
    }
}
