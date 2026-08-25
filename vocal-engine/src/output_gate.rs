use serde::Serialize;

const DEFAULT_LEASE_MS: u64 = 500;
const MAXIMUM_SAFE_INPUT_PEAK_DBFS: f32 = -3.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputBlocker {
    OperatorNotRequested,
    RouteNotVerified,
    ClockNotLocked,
    DryFallbackNotVerified,
    InputLevelsNotFresh,
    InputLevelInvalid,
    InputLevelTooHot,
    ControlPathUnhealthy,
    LeaseExpired,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct OutputConditions {
    pub operator_requested: bool,
    pub route_verified: bool,
    pub clock_locked: bool,
    pub dry_fallback_verified: bool,
    pub input_levels_fresh: bool,
    pub input_peaks_dbfs: [Option<f32>; 3],
    pub control_path_healthy: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLease {
    pub id: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDecision {
    pub authorization: Option<OutputLease>,
    pub revoked_id: Option<u64>,
    pub blockers: Vec<OutputBlocker>,
    pub physical_output_started: bool,
    pub qu16_writes_performed: bool,
}

pub struct OutputGate {
    lease_ms: u64,
    next_id: u64,
    active: Option<OutputLease>,
}

impl Default for OutputGate {
    fn default() -> Self {
        Self::new(DEFAULT_LEASE_MS)
    }
}

impl OutputGate {
    pub fn new(lease_ms: u64) -> Self {
        Self {
            lease_ms: lease_ms.max(1),
            next_id: 1,
            active: None,
        }
    }

    pub fn evaluate(&mut self, conditions: &OutputConditions, now_ms: u64) -> OutputDecision {
        let blockers = blockers(conditions);
        if blockers.is_empty() {
            let lease = match self.active {
                Some(active) => OutputLease {
                    expires_at_ms: now_ms.saturating_add(self.lease_ms),
                    ..active
                },
                None => {
                    let lease = OutputLease {
                        id: self.next_id,
                        expires_at_ms: now_ms.saturating_add(self.lease_ms),
                    };
                    self.next_id = self.next_id.saturating_add(1);
                    lease
                }
            };
            self.active = Some(lease);
            return decision(self.active, None, Vec::new());
        }

        let revoked_id = self.active.take().map(|lease| lease.id);
        decision(None, revoked_id, blockers)
    }

    pub fn tick(&mut self, now_ms: u64) -> OutputDecision {
        if self
            .active
            .is_some_and(|lease| now_ms > lease.expires_at_ms)
        {
            let revoked_id = self.active.take().map(|lease| lease.id);
            return decision(None, revoked_id, vec![OutputBlocker::LeaseExpired]);
        }
        decision(self.active, None, Vec::new())
    }
}

fn blockers(conditions: &OutputConditions) -> Vec<OutputBlocker> {
    let mut result = Vec::new();
    if !conditions.operator_requested {
        result.push(OutputBlocker::OperatorNotRequested);
    }
    if !conditions.route_verified {
        result.push(OutputBlocker::RouteNotVerified);
    }
    if !conditions.clock_locked {
        result.push(OutputBlocker::ClockNotLocked);
    }
    if !conditions.dry_fallback_verified {
        result.push(OutputBlocker::DryFallbackNotVerified);
    }
    if !conditions.input_levels_fresh {
        result.push(OutputBlocker::InputLevelsNotFresh);
    }
    if conditions
        .input_peaks_dbfs
        .iter()
        .any(|peak| peak.is_none_or(|value| !value.is_finite()))
    {
        result.push(OutputBlocker::InputLevelInvalid);
    }
    if conditions
        .input_peaks_dbfs
        .iter()
        .flatten()
        .any(|peak| *peak > MAXIMUM_SAFE_INPUT_PEAK_DBFS)
    {
        result.push(OutputBlocker::InputLevelTooHot);
    }
    if !conditions.control_path_healthy {
        result.push(OutputBlocker::ControlPathUnhealthy);
    }
    result
}

fn decision(
    authorization: Option<OutputLease>,
    revoked_id: Option<u64>,
    blockers: Vec<OutputBlocker>,
) -> OutputDecision {
    OutputDecision {
        authorization,
        revoked_id,
        blockers,
        physical_output_started: false,
        qu16_writes_performed: false,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputGateReplayReport {
    pub mode: &'static str,
    pub decisions: Vec<OutputDecision>,
    pub physical_output_started: bool,
    pub qu16_writes_performed: bool,
    pub hardware_ready: bool,
}

pub fn run_default_output_gate_replay() -> OutputGateReplayReport {
    let mut gate = OutputGate::default();
    let mut conditions = safe_conditions();
    let mut decisions = vec![gate.evaluate(&conditions, 1_000)];

    conditions.input_peaks_dbfs[1] = Some(-1.0);
    decisions.push(gate.evaluate(&conditions, 1_100));

    conditions.input_peaks_dbfs[1] = Some(-12.0);
    decisions.push(gate.evaluate(&conditions, 1_200));

    conditions.clock_locked = false;
    decisions.push(gate.evaluate(&conditions, 1_300));

    conditions.clock_locked = true;
    decisions.push(gate.evaluate(&conditions, 1_400));
    decisions.push(gate.tick(1_901));

    OutputGateReplayReport {
        mode: "minimal_revocable_output_gate",
        decisions,
        physical_output_started: false,
        qu16_writes_performed: false,
        hardware_ready: false,
    }
}

fn safe_conditions() -> OutputConditions {
    OutputConditions {
        operator_requested: true,
        route_verified: true,
        clock_locked: true,
        dry_fallback_verified: true,
        input_levels_fresh: true,
        input_peaks_dbfs: [Some(-12.0); 3],
        control_path_healthy: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_conditions_do_not_authorize() {
        let mut gate = OutputGate::default();
        let decision = gate.evaluate(&OutputConditions::default(), 0);
        assert!(decision.authorization.is_none());
        assert!(!decision.blockers.is_empty());
    }

    #[test]
    fn unsafe_level_revokes_immediately() {
        let mut gate = OutputGate::default();
        let mut conditions = safe_conditions();
        let id = gate.evaluate(&conditions, 0).authorization.unwrap().id;
        conditions.input_peaks_dbfs[0] = Some(-2.9);
        let decision = gate.evaluate(&conditions, 1);
        assert_eq!(decision.revoked_id, Some(id));
        assert_eq!(decision.blockers, vec![OutputBlocker::InputLevelTooHot]);
    }

    #[test]
    fn recovery_gets_a_new_id_and_expiry_revokes_it() {
        let mut gate = OutputGate::new(50);
        let conditions = safe_conditions();
        let first = gate.evaluate(&conditions, 0).authorization.unwrap().id;
        gate.evaluate(&OutputConditions::default(), 1);
        let second = gate.evaluate(&conditions, 2).authorization.unwrap().id;
        assert!(second > first);
        assert_eq!(gate.tick(53).revoked_id, Some(second));
    }

    #[test]
    fn replay_never_starts_output() {
        let report = run_default_output_gate_replay();
        assert_eq!(report.decisions.len(), 6);
        assert_eq!(
            report.decisions[1].blockers,
            vec![OutputBlocker::InputLevelTooHot]
        );
        assert_eq!(
            report.decisions[3].blockers,
            vec![OutputBlocker::ClockNotLocked]
        );
        assert_eq!(
            report.decisions[5].blockers,
            vec![OutputBlocker::LeaseExpired]
        );
        assert!(!report.physical_output_started);
        assert!(!report.qu16_writes_performed);
    }
}
